import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { Automations } from "../apps/control-plane/src/automations.js";
import { EventBus, validate, type BusEvent } from "../apps/control-plane/src/event-bus.js";

const settle = async (check: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
  throw new Error("timed out");
};

const ROOM = "matrix:!silas:example.org";

function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "event-bus-"));
  const dir = join(root, "automations");
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
  const store = new Store(":memory:");
  const control = new AgentControlStore(store.db, { actionsMs: 86_400_000, attachmentsMs: 86_400_000 });
  const turns: Array<{ sessionId: string; input: string }> = [], relayed: BusEvent[] = [], announced: string[] = [];
  let now = Date.UTC(2026, 10, 3, 6, 0);
  const automations = new Automations({ dir, scriptRoots: [], defaultAgent: "pi", operatorTarget: { connector: "app", roomId: "operator", threadId: "" }, push: false }, {
    store: control, registry: { get: () => undefined } as any, dispatch: () => undefined,
    sendTurn: (sessionId, input) => { turns.push({ sessionId, input }); },
    roomTurn: async (target, input) => { turns.push({ sessionId: `room:${target.roomId}`, input }); return "room-session"; },
    now: () => now });
  automations.reload();
  const bus = (accept: (event: BusEvent) => boolean = (event) => automations.onEvent(event)) => new EventBus(
    { sources: ["silas-grey"], hookSources: ["ha"] },
    { db: control.db, dispatch: accept, stale: (source, stale, at) => automations.onStale(source, stale, at),
      relay: (event) => { relayed.push(event); }, announce: (text) => { announced.push(text); }, now: () => now });
  const room = () => control.notices({ connector: "matrix", limit: 50 }).map((n) => n.text);
  return { automations, control, bus, turns, relayed, announced, room, advance: (ms: number) => { now += ms; }, now: () => now,
    close: async () => {
      // Runs finish asynchronously; let them write their result before the database goes.
      await settle(() => (control.db.prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE status='running'").get() as { n: number }).n === 0);
      store.db.close(); rmSync(root, { recursive: true, force: true });
    } };
}

const event = (now: number, extra: Partial<BusEvent> = {}): BusEvent => ({ v: 1, eventId: "e1", source: "silas-grey", type: "silas.position.opened",
  key: "position:1", revision: 1, state: "message", level: "notice", handling: "notify", title: "开仓 ETHUSDT", body: "多 0.1 @ 3200",
  createdAt: now, expiresAt: now + 3_600_000, ...extra });
const mqtt = (bus: EventBus, value: unknown, topic = "uctw/messages/silas-grey/events") => bus.receive(topic, Buffer.from(JSON.stringify(value)));

test("events from MQTT reach matching rules once: notify posts to the room, investigate also wakes its session", async () => {
  const f = fixture({
    "silas/notify/automation.yaml": `title: Silas\ntrigger: { event: { source: silas-grey } }\nroom: { to: "${ROOM}" }\n`,
    "silas/investigate/automation.yaml": `title: Silas 调查\ntrigger: { event: { source: silas-grey, handling: investigate } }\nsession: { id: codex-silas }\n`,
    "silas/halts/automation.yaml": `title: 只看暂停\ntrigger: { event: { source: silas-grey, type: "silas.halt.*" } }\nroom: { to: "matrix:!ops:example.org", text: "{title}（{data.reason}）" }\n`,
  });
  try {
    const bus = f.bus();
    assert.equal(mqtt(bus, event(f.now())), true);
    assert.equal(mqtt(bus, event(f.now())), true, "a redelivery is acknowledged");
    mqtt(bus, event(f.now(), { eventId: "e2", type: "silas.halt.budget", key: "halt:1", handling: "investigate", title: "预算耗尽，已暂停", body: "回撤超出预算", data: { reason: "drawdown" } }));
    await settle(() => f.room().length === 3 && f.turns.length === 1);
    assert.deepEqual(f.room().sort(), ["开仓 ETHUSDT\n多 0.1 @ 3200", "预算耗尽，已暂停\n回撤超出预算", "预算耗尽，已暂停（drawdown）"].sort());
    assert.equal(f.turns[0]!.sessionId, "codex-silas");
    assert.match(f.turns[0]!.input, /^\[事件 · Silas 调查\] 下面是事件总线上的事件（来源 silas-grey）[\s\S]*预算耗尽，已暂停\n回撤超出预算$/);
    assert.equal(f.relayed.length, 0, "what came from MQTT is not published again");
  } finally { await f.close(); }
});

test("out-of-order, expired, foreign and malformed events are acknowledged but never offered", async () => {
  const f = fixture();
  try {
    const offered: string[] = [], bus = f.bus((e) => { offered.push(e.eventId); return true; });
    mqtt(bus, event(f.now(), { eventId: "new", revision: 5 }));
    mqtt(bus, event(f.now(), { eventId: "old", revision: 3 }));
    mqtt(bus, event(f.now(), { eventId: "late", key: "k2", expiresAt: f.now() - 1, createdAt: f.now() - 10 }));
    mqtt(bus, { ...event(f.now(), { eventId: "spoof" }), source: "ha" });
    assert.equal(bus.receive("uctw/messages/silas-grey/events", Buffer.from("{")), true);
    assert.equal(bus.receive("uctw/messages/silas-grey/state/abc", Buffer.alloc(0)), true, "a cleared retained state");
    mqtt(bus, event(f.now(), { eventId: "other" }), "uctw/messages/polymaker/events");
    assert.deepEqual(offered, ["new"]);
  } finally { await f.close(); }
});

test("POST /events/<source>: a LAN source sends a short v1 body; it is filled, offered and published under its source", async () => {
  const f = fixture({ "home/ha/automation.yaml": `title: HA\ntrigger: { event: { source: ha } }\nroom: { to: "matrix:!home:example.org" }\n` });
  try {
    const bus = f.bus(), body = (value: unknown) => Buffer.from(JSON.stringify(value));
    assert.equal(bus.hook("silas-grey", body({})).status, 404, "only the listed hook sources");
    assert.equal(bus.hook("ha", Buffer.from("x")).status, 400);
    assert.equal(bus.hook("ha", body({ eventId: "t1", type: "ha.door" })).status, 400, "a title is required");
    const first = bus.hook("ha", body({ eventId: "d1", type: "ha.doorbell", key: "door:front", title: "门铃", level: "critical" }));
    assert.deepEqual([first.status, first.body], [202, { accepted: true, eventId: "d1" }]);
    assert.equal(bus.hook("ha", body({ eventId: "d1", type: "ha.doorbell", key: "door:front", title: "门铃" })).status, 200, "a retry is a duplicate");
    await settle(() => f.control.notices({ connector: "matrix", limit: 5 }).length === 1);
    assert.equal(f.relayed.length, 1);
    const sent = f.relayed[0]!;
    assert.deepEqual([sent.source, sent.state, sent.level, sent.handling, sent.expiresAt - sent.createdAt], ["ha", "message", "critical", "notify", 86_400_000]);
    assert.ok(sent.revision >= f.now(), "a revision the source did not give is assigned");
    assert.equal(validate({ ...event(f.now()), level: "critical" }, "silas-grey", false).ok && (validate({ ...event(f.now()), level: "critical" }, "silas-grey", false) as any).event.level, "alert",
      "critical is HA's alone");
  } finally { await f.close(); }
});

test("a heartbeat that expires fires stale once and again on recovery; MQTT heartbeats wait for a settled subscription", async () => {
  const f = fixture({ "home/down/automation.yaml": `title: HA 掉线\ntrigger: { stale: { source: ha } }\nroom: { to: "matrix:!home:example.org", text: "{text}", agent: "{stale}" }\n` });
  try {
    const bus = f.bus(), beat = (id: string) => bus.hook("ha", Buffer.from(JSON.stringify({ eventId: id, type: "heartbeat", key: "heartbeat", state: "active", title: "alive",
      expiresAt: f.now() + 180_000 })));
    beat("h1");
    assert.equal(f.relayed.length, 1, "heartbeats are published like any event");
    f.advance(120_000); bus.check();
    assert.equal(f.control.notices({ connector: "matrix", limit: 5 }).length, 0, "not yet expired");
    f.advance(120_000); bus.check(); bus.check();
    await settle(() => f.turns.length === 1);
    assert.match(f.room()[0]!, /^⚠️ ha 没有心跳了/);
    beat("h2"); bus.check();
    await settle(() => f.room().length === 2);
    assert.equal(f.room()[1], "✅ ha 恢复心跳");
    assert.equal(f.turns.length, 1, "the recovery does not wake the agent");

    // From MQTT, while the subscription has never been up (the broker is away): nothing is judged.
    mqtt(bus, event(f.now(), { eventId: "hb", type: "heartbeat", key: "heartbeat", state: "active", expiresAt: f.now() + 1_000 }),
      "uctw/messages/silas-grey/state/x");
    f.advance(10 * 60_000); bus.check();
    assert.equal((bus.status().heartbeats as any[]).find((row) => row.source === "silas-grey").stale, 0);
  } finally { await f.close(); }
});

test("an event stored but not offered (a restart in between) is offered on the next start, within the hour", async () => {
  const f = fixture();
  try {
    f.bus(() => false).receive("uctw/messages/silas-grey/events", Buffer.from(JSON.stringify(event(f.now()))));
    const offered: string[] = [];
    const next = f.bus((e) => { offered.push(e.eventId); return true; });
    next.start(); next.stop();
    assert.deepEqual(offered, ["e1"]);
    const again: string[] = [];
    const third = f.bus((e) => { again.push(e.eventId); return true; });
    third.start(); third.stop();
    assert.deepEqual(again, [], "offered once");
  } finally { await f.close(); }
});
