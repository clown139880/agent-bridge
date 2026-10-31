import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { AgentMessagePublisher, type BusinessMessage } from "../apps/control-plane/src/message-publisher.js";

function fixture() {
  const store = new Store(":memory:");
  store.upsertMachine({ id: "hal", name: "hal", hostname: "hal", platform: "linux", capabilities: [] });
  store.createSession({ id: "session", machineId: "hal", agentType: "codex-cli", projectName: "项目",
    projectPath: "/tmp/project", matrixRoomId: "", matrixThreadId: null, nativeSessionId: "native",
    status: "working", createdAt: Date.now(), updatedAt: Date.now() });
  const control = new AgentControlStore(store.db, { actionsMs: 86_400_000, attachmentsMs: 86_400_000 });
  let now = Date.now(), offline = false, relayed = false;
  const deliveries: Array<{ topic: string; payload: string; retain: boolean }> = [];
  const publisher = () => new AgentMessagePublisher(store, control, { url: "mqtt://localhost:1883" }, {
    now: () => now, relayed: () => relayed, publish: async (topic, payload, retain) => {
      if (offline) throw new Error("offline");
      deliveries.push({ topic, payload, retain });
    },
  });
  const event = (id: string, turnId: string, type = "turn.completed", summary = "完成") => control.appendSessionEvent({
    type: "session.event", eventId: id, eventType: type as "turn.completed", sessionId: "session", turnId,
    timestamp: now, payload: { summary },
  });
  const approval = () => control.upsertApproval("hal", { approvalId: "request", sessionId: "session", turnId: "turn",
    kind: "Bash", summary: "请确认操作", choices: ["allow", "deny"], requestedAt: now });
  return { store, control, deliveries, publisher, event, approval,
    advance: (ms: number) => { now += ms; }, setOffline: (value: boolean) => { offline = value; },
    setRelayed: (value: boolean) => { relayed = value; } };
}

test("first activation skips historical turns and reconciles outstanding requests once", async () => {
  const f = fixture();
  try {
    f.event("old", "old"); f.approval();
    const producer = f.publisher(); producer.capture(); await producer.flush();
    assert.equal(f.deliveries.length, 1);
    const message = JSON.parse(f.deliveries[0]!.payload) as BusinessMessage;
    assert.equal(message.state, "active");
    assert.equal(message.type, "agent.approval.requested");
    assert.match(f.deliveries[0]!.topic, /^uctw\/messages\/agent-bridge\/state\/[a-f0-9]{32}$/);
    assert.equal(f.deliveries[0]!.retain, true);
    const restarted = f.publisher(); restarted.capture(); await restarted.flush();
    assert.equal(f.deliveries.length, 1);
  } finally { f.store.db.close(); }
});

test("terminal events are durable, Unicode bounded and distinct per turn; replay and progress stay quiet", async () => {
  const f = fixture();
  try {
    const producer = f.publisher();
    f.event("one", "turn-1", "turn.completed", "😀".repeat(1000));
    assert.equal(f.event("one", "turn-1"), false);
    f.event("progress", "turn-1", "tool.completed");
    f.event("two", "turn-2", "turn.failed", "失败原因");
    producer.capture(); await producer.flush();
    assert.equal(f.deliveries.length, 2);
    const [one, two] = f.deliveries.map(d => JSON.parse(d.payload) as BusinessMessage);
    assert.notEqual(one!.key, two!.key);
    assert.equal(Array.from(one!.body!).length, 600);
    assert.equal(one!.level, "notice"); assert.equal(two!.level, "alert");
    assert.equal(one!.url, "/control/sessions/session");
    assert.equal(f.deliveries[0]!.retain, false);
    assert.equal(f.deliveries[0]!.topic, "uctw/messages/agent-bridge/events");
    const restarted = f.publisher(); restarted.capture(); await restarted.flush();
    assert.equal(f.deliveries.length, 2);
  } finally { f.store.db.close(); }
});

test("a session a chat room relays reaches the phone quietly, except failures", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.setRelayed(true);
    f.event("one", "turn-1"); f.event("two", "turn-2", "turn.failed", "失败"); f.approval();
    producer.capture(); await producer.flush();
    const levels = f.deliveries.map(d => (JSON.parse(d.payload) as BusinessMessage).level);
    assert.deepEqual(levels, ["silent", "alert", "silent"]);
    f.setRelayed(false); f.event("three", "turn-3"); producer.capture(); await producer.flush();
    assert.equal((JSON.parse(f.deliveries[3]!.payload) as BusinessMessage).level, "notice", "after new the phone alerts again");
  } finally { f.store.db.close(); }
});

test("pending snapshots do not renew notifications and resolution has a newer durable revision", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.approval(); producer.capture(); await producer.flush();
    const active = JSON.parse(f.deliveries[0]!.payload) as BusinessMessage;
    f.advance(1000); f.approval(); producer.capture(); await producer.flush();
    assert.equal(f.deliveries.length, 1);
    f.control.resolvePending("request", "accepted", { choice: "allow" });
    const restarted = f.publisher(); restarted.capture(); await restarted.flush();
    const resolved = JSON.parse(f.deliveries[1]!.payload) as BusinessMessage;
    assert.equal(resolved.state, "resolved"); assert.equal(resolved.key, active.key);
    assert.ok(resolved.revision > active.revision);
    f.advance(1000); f.approval(); restarted.capture(); await restarted.flush();
    assert.equal(f.deliveries.length, 2, "late pending replay must not resurrect a resolved request");
  } finally { f.store.db.close(); }
});

test("offline retries survive restart with the same identity and original expiry", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.event("one", "turn"); producer.capture();
    const queued = f.store.db.prepare("SELECT payload FROM message_outbox WHERE status='pending'").get() as { payload: string };
    f.setOffline(true); await producer.flush(); assert.equal(producer.status().pending, 1);
    f.setOffline(false);
    const restarted = f.publisher(); await restarted.flush(); assert.equal(f.deliveries.length, 0, "respect saved backoff");
    f.advance(10_001); restarted.capture(); await restarted.flush();
    assert.equal(f.deliveries[0]!.payload, queued.payload);
    assert.equal(restarted.status().accepted, 1);
  } finally { f.store.db.close(); }
});

test("resolution supersedes an unsent active request instead of retrying both", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.approval(); producer.capture();
    f.setOffline(true); await producer.flush();
    f.control.resolvePending("request", "resolved_elsewhere"); producer.capture();
    f.setOffline(false); await producer.flush();
    assert.equal(f.deliveries.length, 1);
    assert.equal(JSON.parse(f.deliveries[0]!.payload).state, "resolved");
  } finally { f.store.db.close(); }
});

test("expired events are not delivered and expired retained state is explicitly cleared", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.approval(); f.event("old", "turn"); producer.capture();
    f.advance(600_001); await producer.flush();
    assert.equal(f.deliveries.length, 1); assert.equal(JSON.parse(f.deliveries[0]!.payload).state, "active");
    f.advance(86_400_000); producer.capture(); await producer.flush();
    assert.equal(f.deliveries.length, 2); assert.equal(f.deliveries[1]!.payload, "");
    assert.equal(f.deliveries[1]!.retain, true);
    assert.equal(f.deliveries[0]!.topic, f.deliveries[1]!.topic);
  } finally { f.store.db.close(); }
});

test("outbox, key and replay cursor commit atomically", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.event("one", "turn");
    f.store.db.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON message_publisher_keys
      BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;`);
    assert.throws(() => producer.capture(), /simulated disk failure/);
    assert.equal(producer.status().pending, 0);
    f.store.db.exec("DROP TRIGGER reject_message");
    producer.capture(); await producer.flush(); assert.equal(f.deliveries.length, 1);
  } finally { f.store.db.close(); }
});

test("API action completion resolves input notifications without publishing answer contents", async () => {
  const f = fixture();
  try {
    const producer = f.publisher();
    f.control.upsertUserInput("hal", { requestId: "input", sessionId: "session", turnId: "turn", requestedAt: Date.now(),
      questions: [{ id: "q", header: "选择", question: "怎么继续？", options: [{ label: "继续", description: "执行下一步" }] }] });
    producer.capture(); await producer.flush();
    const created = f.control.createAction({ principal: "test", key: "answer", method: "POST", path: "/answer",
      body: { answers: { q: { answers: ["private-answer"] } } }, kind: "resolve_user_input", machineId: "hal", sessionId: "session" });
    assert.equal(f.control.reservePending("input", created.action.actionId), true);
    f.control.completeAction({ type: "action.result", actionId: created.action.actionId, kind: "resolve_user_input",
      status: "succeeded", sessionId: "session", timestamp: Date.now() });
    producer.capture(); await producer.flush();
    assert.equal(f.deliveries.length, 2);
    const resolved = JSON.parse(f.deliveries[1]!.payload) as BusinessMessage;
    assert.equal(resolved.type, "agent.input.resolved");
    assert.equal(resolved.key, JSON.parse(f.deliveries[0]!.payload).key);
    assert.equal(f.deliveries.some(d => d.payload.includes("private-answer")), false);
  } finally { f.store.db.close(); }
});

test("session deletion clears a previously published pending notification", async () => {
  const f = fixture();
  try {
    const producer = f.publisher(); f.approval(); producer.capture(); await producer.flush();
    const active = JSON.parse(f.deliveries[0]!.payload) as BusinessMessage;
    f.control.deleteSession("session"); producer.capture(); await producer.flush();
    const resolved = JSON.parse(f.deliveries[1]!.payload) as BusinessMessage;
    assert.equal(resolved.key, active.key); assert.equal(resolved.state, "resolved");
    assert.ok(resolved.revision > active.revision);
  } finally { f.store.db.close(); }
});

test("a real MQTT QoS1 publication stays pending until PUBACK", async t => {
  const f = fixture();
  let acknowledge: (() => void) | undefined;
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let size = 0, multiplier = 1, offset = 1, digit: number;
        do {
          if (offset >= buffered.length) return;
          digit = buffered[offset++]!; size += (digit & 127) * multiplier; multiplier *= 128;
        } while (digit & 128);
        if (buffered.length < offset + size) return;
        const packet = buffered.subarray(0, offset + size), type = packet[0]! >> 4;
        buffered = buffered.subarray(offset + size);
        if (type === 1) socket.write(Buffer.from([0x20, 2, 0, 0]));
        if (type === 3) {
          const topicLength = packet.readUInt16BE(offset), idAt = offset + 2 + topicLength;
          const id = packet.readUInt16BE(idAt);
          acknowledge = () => socket.write(Buffer.from([0x40, 2, id >> 8, id & 255]));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const producer = new AgentMessagePublisher(f.store, f.control, { url: `mqtt://127.0.0.1:${port}` });
  t.after(async () => { await producer.stop(); await new Promise<void>(resolve => server.close(() => resolve())); f.store.db.close(); });
  f.event("one", "turn"); producer.capture(); const flushing = producer.flush();
  for (let i = 0; !acknowledge && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(acknowledge, "broker received the publication");
  assert.equal(producer.status().pending, 1);
  acknowledge(); await flushing; assert.equal(producer.status().accepted, 1);
});
