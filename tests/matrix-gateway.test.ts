import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { AgentMemory } from "../packages/agent-memory/src/index.js";
import { SessionMemory } from "../apps/control-plane/src/session-memory.js";
import { MatrixGateway } from "../apps/control-plane/src/matrix/gateway.js";
import { command, message, splitMessage, threadOf } from "../apps/control-plane/src/matrix/render.js";
import type { MatrixConfig } from "../apps/control-plane/src/matrix/config.js";
import type { MatrixEvent, MatrixTransport } from "../apps/control-plane/src/matrix/transport.js";
import type { MatrixControl, Json } from "../apps/control-plane/src/matrix/api.js";

const roomId = "!project:example.org", user = "@human:example.org";
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "matrix-gateway-"));
  const root = join(dir, "agent-memory");
  mkdirSync(join(root, "scopes"), { recursive: true });
  writeFileSync(join(root, "predicates.yaml"), "predicates:\n  - id: rule\n");
  for (const scope of ["_global", "demo", "other"]) {
    mkdirSync(join(root, "scopes", scope));
    writeFileSync(join(root, "scopes", scope, "scope.md"), `---\ntype: scope\nid: ${scope}\ntitle: ${scope}\nstatus: active\ndiscoverable: true\nbindings:\n  matrix_rooms: []\n  repositories: []\n  locations: []\n---\n${scope} memory\n`);
    writeFileSync(join(root, "scopes", scope, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  }
  const legacy = new Store(join(dir, "db.sqlite"));
  const control = new AgentControlStore(legacy.db, { actionsMs: 1, attachmentsMs: 100000 });
  legacy.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: ["codex-cli"] });
  const memory = new SessionMemory(control, new AgentMemory({ vault: dir }));
  const config: MatrixConfig = { homeserver: "https://example.org", userId: "@bot:example.org", stateFile: join(dir, "device.json"),
    rooms: [{ roomId, scopeId: "demo", users: [user, "@second:example.org"], defaultTarget: "codex",
      targets: { codex: { workerId: "codex@dev", workspace: "/work" }, claude: { workerId: "claude@dev", workspace: "/work" } } }] };
  const calls: Array<{ path: string; body?: Json; key?: string }> = [], sends: Array<{ roomId: string; content: Json; txn: string; type: string }> = [];
  let sessionSeq = 0, turnSeq = 0, eventSeq = 0, deferInterrupt: (() => void) | undefined;
  let holdInterrupt = false, mediaResolve: (() => void) | undefined, delayDownload = false;
  const receipts = new Map<string, Json>();
  const event = (sessionId: string, turnId: string, type: string, payload: Json = {}): void => {
    control.appendSessionEvent({ type: "session.event", eventId: `fixture:${++eventSeq}`, sessionId, turnId,
      eventType: type as any, timestamp: Date.now(), payload });
    if (type === "turn.started") control.updateSessionActivity(sessionId, "active", turnId);
    if (type.startsWith("turn.") && type !== "turn.started") control.updateSessionActivity(sessionId, "idle", undefined, type === "turn.interrupted" ? "interrupted" : "completed");
  };
  const api: MatrixControl = { async call(sender, path, body, key) {
    calls.push({ path, body, key });
    if (key && receipts.has(key)) return receipts.get(key)!;
    if (path.startsWith("/actions/")) return [...receipts.values()].find(a => path.endsWith(a.actionId))!;
    const receipt: Json = { actionId: `a${calls.length}`, status: "succeeded" };
    if (path === "/sessions") {
      const sessionId = `session-${++sessionSeq}`;
      control.upsertSession("dev", { sessionId, agentType: body!.workerId.startsWith("claude") ? "claude-code" : "codex-cli", projectPath: "/work",
        projectName: "work", activityStatus: "idle", source: "app-server", historyCompleteness: "full", createdAt: Date.now(), updatedAt: Date.now() });
      control.bindMemory(sessionId, body!.memoryScopeId, body!.originRoomId);
      receipt.sessionId = sessionId;
    } else if (path.endsWith("/interrupt")) {
      const sessionId = decodeURIComponent(path.split("/")[2]!);
      const finish = (): void => event(sessionId, body!.expectedTurnId, "turn.interrupted");
      if (holdInterrupt) deferInterrupt = finish; else finish();
      receipt.sessionId = sessionId;
    } else if (path.endsWith("/turns")) {
      const sessionId = decodeURIComponent(path.split("/")[2]!);
      assert.equal(control.session(sessionId)?.activeTurnId, null, "old turn must have actually ended");
      assert.equal(body?.delivery, "start_turn");
      receipt.sessionId = sessionId; receipt.turnId = `turn-${++turnSeq}`;
      event(sessionId, receipt.turnId, "turn.started");
    } else if (path.includes("/decision")) {
      control.resolvePending(decodeURIComponent(path.split("/")[2]!), "accepted", body);
    } else if (path.includes("/response")) control.resolvePending(decodeURIComponent(path.split("/")[2]!), "accepted", body);
    if (key) receipts.set(key, receipt);
    return receipt;
  } };
  const transport: MatrixTransport = { async open() {}, async sync() { throw new Error("test manually ingests"); },
    async history() { return { chunk: [] }; }, async send(roomId, type, content, txn) {
      sends.push({ roomId, type, content, txn }); return `$out${sends.length}`;
    }, async download() { if (delayDownload) await new Promise<void>(resolve => { mediaResolve = resolve; }); return Buffer.from("image bytes"); }, close() {} };
  let gateway = new MatrixGateway(control, config, transport, api, memory);
  (gateway as any).connected = true;
  let syncSeq = 0;
  const ingest = async (...events: MatrixEvent[]): Promise<void> => {
    await gateway.ingest({ next_batch: `sync-${++syncSeq}`, rooms: { join: { [roomId]: { timeline: { events } } } } });
    await gateway.tick();
  };
  const text = (id: string, body: string, extra: Json = {}, sender = user): MatrixEvent => ({ event_id: id, type: "m.room.message", sender, content: { msgtype: "m.text", body, ...extra } });
  const media = (id: string, sender = user): MatrixEvent => ({ event_id: id, type: "m.room.message", sender,
    content: { msgtype: "m.image", body: "this caption must not start a turn", info: { mimetype: "image/png" }, url: "mxc://example.org/a" } });
  const drain = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 160; i++) { if (predicate()) return; await gateway.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(predicate(), "condition did not become true");
  };
  t.after(async () => { mediaResolve?.(); deferInterrupt?.(); await gateway.stop(); legacy.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, control, config, memory, api, transport, calls, sends, text, media, ingest, drain, event,
    get gateway() { return gateway; },
    deferMedia() { delayDownload = true; }, releaseMedia() { delayDownload = false; mediaResolve?.(); },
    deferStop() { holdInterrupt = true; }, releaseStop() { holdInterrupt = false; deferInterrupt?.(); },
    async restart() { await gateway.stop(); gateway = new MatrixGateway(control, config, transport, api, memory); (gateway as any).connected = true; },
    turns: () => calls.filter(c => c.path.endsWith("/turns")),
  };
}

test("commands accept both prefixes, only native threads route, Markdown is safe and byte bounded", () => {
  assert.deepEqual(command("/new claude"), command("!new claude"));
  assert.equal(command("/tmp/example"), undefined);
  assert.equal(threadOf({ "m.relates_to": { "m.in_reply_to": { event_id: "$ordinary" } } }), "");
  assert.equal(threadOf({ "m.relates_to": { rel_type: "m.thread", event_id: "$thread", "m.in_reply_to": { event_id: "$reply" } } }), "$thread");
  const html = message('[bad](javascript:alert(1))<script>evil()</script><img src=x onerror=alert(1)>').formatted_body;
  assert.doesNotMatch(html, /javascript|script|onerror|<img/);
  const original = "汉😀".repeat(18000), pieces = splitMessage(original);
  assert.equal(pieces.join(""), original); assert.ok(pieces.every(piece => Buffer.byteLength(piece) <= 12000));
  assert.ok(splitMessage("&".repeat(30000)).every(piece => Buffer.byteLength(JSON.stringify(message(piece))) < 60000));
});

test("initial history, own events, edits and unauthorized senders never submit", async t => {
  const f = fixture(t);
  await f.ingest(f.text("old", "historical"));
  await f.ingest(f.text("self", "loop", {}, f.config.userId), f.text("stranger", "execute", {}, "@stranger:example.org"),
    f.text("edit", "edit", { "m.relates_to": { rel_type: "m.replace", event_id: "old" } }));
  assert.equal(f.calls.length, 0);
});

test("attachments persist without interrupt; text seals prior downloads and later media belongs to next batch", async t => {
  const f = fixture(t); await f.ingest();
  f.deferMedia(); await f.ingest(f.media("image1"));
  await f.ingest(f.text("text1", "compare these"));
  await f.drain(() => f.calls.some(c => c.path === "/sessions"));
  assert.equal(f.turns().length, 0);
  f.releaseMedia(); await f.drain(() => f.turns().length === 1);
  assert.equal(f.turns()[0]!.body!.attachments.length, 1);
  await f.ingest(f.media("image2"));
  assert.equal(f.turns().length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith("/interrupt")).length, 0);
  await f.ingest(f.text("help", "/help"));
  assert.equal(f.control.db.prepare("SELECT batch_id FROM matrix_media WHERE event_id='image2'").get()!.batch_id, null);
});

test("interrupt receipt is not settlement; texts merge while stopping then submit once in order", async t => {
  const f = fixture(t); await f.ingest(); await f.ingest(f.text("first", "first task"));
  await f.drain(() => f.turns().length === 1);
  f.deferStop(); await f.ingest(f.text("second", "second task"));
  await f.drain(() => f.calls.some(c => c.path.endsWith("/interrupt")));
  await f.ingest(f.text("third", "additional instruction"));
  assert.equal(f.turns().length, 1);
  f.releaseStop(); await f.drain(() => f.turns().length === 2);
  assert.equal(f.turns()[1]!.body!.input, "second task\n\nadditional instruction");
  assert.equal(f.calls.filter(c => c.path.endsWith("/interrupt")).length, 1);
});

test("replay and restart retain drafts and never resubmit accepted text", async t => {
  const f = fixture(t); await f.ingest(); await f.ingest(f.media("draft"));
  await f.drain(() => f.control.db.prepare("SELECT status FROM matrix_media").get()!.status === "ready");
  await f.restart(); await f.ingest(f.text("send", "with my draft"));
  await f.drain(() => f.turns().length === 1);
  await f.drain(() => f.control.db.prepare("SELECT status FROM matrix_batches").get()!.status === "committed");
  await f.restart(); await f.ingest(f.text("send", "with my draft"));
  assert.equal(f.turns().length, 1); assert.equal(f.turns()[0]!.body!.attachments.length, 1);
});

test("room threads and senders isolate drafts while sharing durable memory scope", async t => {
  const f = fixture(t); await f.ingest();
  await f.ingest(f.media("other-person", "@second:example.org"));
  const relation = { "m.relates_to": { rel_type: "m.thread", event_id: "$thread" } };
  await f.ingest(f.text("thread-task", "in thread", relation)); await f.drain(() => f.turns().length === 1);
  await f.ingest(f.text("room-task", "in room")); await f.drain(() => f.turns().length === 2);
  assert.equal(f.turns().filter(c => c.body?.attachments).length, 0);
  const sessions = f.control.db.prepare("SELECT * FROM session_memory").all();
  assert.equal(sessions.length, 2); assert.ok(sessions.every(s => s.scope_id === "demo"));
});

test("approval reactions use exact pending ids and offered options without consuming drafts", async t => {
  const f = fixture(t); await f.ingest(); await f.ingest(f.text("task", "work")); await f.drain(() => f.turns().length === 1);
  f.control.upsertApproval("dev", { approvalId: "approve-1", sessionId: "session-1", turnId: "turn-1", kind: "command", summary: "test", choices: ["allow", "deny"] });
  f.gateway.capture(); await f.gateway.flush();
  const prompt = f.control.db.prepare("SELECT event_id FROM matrix_outbox WHERE pending_id='approve-1' AND event_id IS NOT NULL").get()!;
  await f.ingest(f.media("draft"));
  const imageReply = f.media("approval-image");
  imageReply.content.body = "1";
  imageReply.content["m.relates_to"] = { "m.in_reply_to": { event_id: prompt.event_id } };
  await f.ingest(imageReply);
  assert.equal(f.calls.filter(c => c.path === "/approvals/approve-1/decision").length, 0, "a media filename is not an approval response");
  await f.ingest({ event_id: "$reaction", sender: user, type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: prompt.event_id, key: "✅" } } });
  assert.equal(f.calls.filter(c => c.path === "/approvals/approve-1/decision").length, 1);
  assert.equal(f.turns().length, 1);
  assert.equal(f.control.db.prepare("SELECT batch_id FROM matrix_media WHERE event_id='draft'").get()!.batch_id, null);
  await f.ingest(f.text("late-answer", "allow", { "m.relates_to": { "m.in_reply_to": { event_id: prompt.event_id } } }));
  assert.equal(f.turns().length, 1);
});

test("old turn output stays pinned when switching binding; binding does not dump history", async t => {
  const f = fixture(t); await f.ingest(); await f.ingest(f.text("task", "work")); await f.drain(() => f.turns().length === 1);
  await f.drain(() => f.control.db.prepare("SELECT status FROM matrix_batches").get()!.status === "committed");
  f.gateway.capture();
  await f.ingest(f.text("new", "!new claude"));
  f.event("session-1", "turn-1", "message.completed", { role: "assistant", text: "old turn answer" });
  f.event("session-1", "turn-1", "turn.completed");
  f.gateway.capture(); await f.gateway.flush();
  assert.equal(f.sends.filter(s => s.content.body === "old turn answer").length, 1);
  const count = f.sends.length; f.gateway.capture(); await f.gateway.flush(); assert.equal(f.sends.length, count);
});

test("download failures retain the complete batch; no partial turn is dispatched", async t => {
  const f = fixture(t); await f.ingest();
  f.transport.download = async () => { throw new Error("download_failed"); };
  await f.ingest(f.media("broken"), f.text("send", "use the attachment"));
  await f.drain(() => f.control.db.prepare("SELECT status FROM matrix_batches").get()?.status === "held");
  assert.equal(f.turns().length, 0);
});

test("limited sync backfills to its saved anchor and never advances across an unresolved gap", async t => {
  const f = fixture(t); await f.ingest(f.text("anchor", "old history"));
  f.transport.history = async () => ({ chunk: [f.text("missed", "missed input"), f.text("anchor", "old history")] });
  await f.gateway.ingest({ next_batch: "after-gap", rooms: { join: { [roomId]: { timeline: { limited: true, prev_batch: "page", events: [f.text("current", "new input")] } } } } });
  assert.deepEqual(f.control.db.prepare("SELECT event_id FROM matrix_inbox ORDER BY seq").all().map(r => r.event_id), ["missed", "current"]);
  f.transport.history = async () => ({ chunk: [] });
  await assert.rejects(f.gateway.ingest({ next_batch: "must-not-save", rooms: { join: { [roomId]: { timeline: { limited: true, prev_batch: "broken", events: [f.text("too-far", "not safe")] } } } } }), /gap_unresolved/);
  assert.equal(f.gateway.store.meta("sync_token"), "after-gap");
});

test("outbox retries reuse transaction ids and discard obsolete status edits", async t => {
  const f = fixture(t); await f.ingest();
  const txns: string[] = []; let fail = true;
  f.transport.send = async (_room, _type, _content, txn) => { txns.push(txn); if (fail) throw new Error("lost-response"); return "$event"; };
  f.gateway.store.say("answer", roomId, "", "one answer");
  await f.gateway.flush(); fail = false;
  f.control.db.prepare("UPDATE matrix_outbox SET next_at=0").run(); await f.gateway.flush();
  assert.deepEqual(txns, [txns[0], txns[0]]);
  f.gateway.store.enqueue("status", roomId, "", message("start"));
  f.gateway.store.enqueue("progress", roomId, "", message("doing"), { replaceKey: "status" });
  f.gateway.store.enqueue("terminal", roomId, "", message("done"), { replaceKey: "status" });
  assert.equal(f.control.db.prepare("SELECT status FROM matrix_outbox WHERE key='progress'").get()!.status, "superseded");
});

test("switching preserves drafts and explicit restore returns to the original generation", async t => {
  const f = fixture(t); await f.ingest(); await f.ingest(f.media("old-draft"));
  await f.ingest(f.text("new", "!new claude"));
  await f.ingest(f.text("restore", "/restore 1"));
  await f.ingest(f.text("submit-old", "use my original image"));
  await f.drain(() => f.turns().length === 1);
  const created = f.calls.find(c => c.path === "/sessions")!;
  assert.equal(created.body!.workerId, "codex@dev");
  assert.equal(f.turns()[0]!.body!.attachments.length, 1);
});
