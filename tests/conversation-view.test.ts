import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { StructuredSessionEventMessage } from "../packages/protocol/src/index.js";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { backfillViewKeys } from "../packages/database/src/view.js";

function setup() {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  store.createSession({ id: "s", machineId: "dev", agentType: "codex-cli", projectName: "p", projectPath: "/tmp/p",
    matrixRoomId: "!r:test", matrixThreadId: null, nativeSessionId: "s", status: "working", createdAt: 1, updatedAt: 1 });
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  let time = 1;
  const append = (eventId: string, eventType: StructuredSessionEventMessage["eventType"], payload: Record<string, unknown> = {}, turnId?: string, itemId?: string) =>
    control.appendSessionEvent({ type: "session.event", sessionId: "s", eventId, eventType, timestamp: ++time, payload, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) });
  return { store, control, append, done: () => { store.db.close(); rmSync(path, { force: true }); } };
}

test("snapshot pages and changes converge on the full projection", () => {
  const { control, append, done } = setup();
  append("u1", "message.completed", { role: "user", text: "one" }, "t1");
  append("a1", "message.completed", { role: "assistant", text: "r1" }, "t1");
  append("c1", "turn.completed", {}, "t1");
  const first = control.viewPage("s", 10);
  assert.deepEqual(first.entries.map(e => [e.key, e.status]), [["t:t1", "completed"]]);
  assert.equal(first.rawHigh > 0, true); assert.match(first.streamCursor, /^c:\d+:\d+$/);

  append("u2", "message.completed", { role: "user", text: "two" }, "t2");
  append("x2", "command.completed", { command: "ls" }, "t2", "call");
  const changes = control.viewChanges("s", first.viewRevision, first.rawHigh);
  assert.equal(changes.hasMore, false); assert.equal(changes.raw.count, 2);
  assert.deepEqual(changes.entries.map(e => e.key).sort(), ["t:t1", "t:t2"], "a new turn re-marks the one it supersedes");
  assert.equal(changes.entries.find(e => e.key === "t:t2")!.items.length, 2);

  // An external client keeps writing to t1 after its terminal event.
  append("late", "message.completed", { role: "assistant", text: "late" }, "t1");
  const later = control.viewChanges("s", changes.toRevision, changes.raw.through);
  const t1 = later.entries.find(e => e.key === "t:t1")!;
  assert.equal(t1.status, "completed"); assert.equal(t1.eventsAfterTerminal, 1);
  assert.deepEqual(later.entries.map(e => e.key), ["t:t1"]);
  assert.equal(later.raw.count, 1);
  done();
});

test("an event revised into another turn reorders: epoch moves and the old entry is reported removed", () => {
  const { control, append, done } = setup();
  append("m", "message.completed", { role: "assistant", text: "orphan" });
  append("u", "message.completed", { role: "user", text: "q" }, "t1");
  const before = control.viewPage("s", 10);
  assert.deepEqual(before.entries.map(e => e.key), ["o:m", "t:t1"]);
  const inserted = control.appendSessionEvent({ type: "session.event", sessionId: "s", eventId: "m", eventType: "message.completed",
    timestamp: 1, turnId: "t1", payload: { role: "assistant", text: "orphan" } });
  assert.equal(inserted, false);
  assert.equal(control.reconcileReplayedEvent({ type: "session.event", sessionId: "s", eventId: "m", eventType: "message.completed",
    timestamp: 1, turnId: "t1", payload: { role: "assistant", text: "orphan" } }), undefined);
  const changes = control.viewChanges("s", before.viewRevision, before.rawHigh);
  assert.equal(changes.orderingEpoch, before.orderingEpoch + 1);
  assert.deepEqual(changes.removed.map(r => r.key), ["o:m"]);
  assert.equal(changes.raw.count, 0, "a revision in place is not a new event");
  assert.throws(() => control.viewPage("s", 10, `v:${before.orderingEpoch}:999`), /cursor_expired/);
  assert.deepEqual(control.viewPage("s", 10).entries.map(e => [e.key, e.anchor]), [["t:t1", 1]]);
  done();
});

test("pages walk back by anchor within the epoch; changes past the current revision are refused", () => {
  const { control, append, done } = setup();
  for (let i = 0; i < 5; i++) append(`u${i}`, "message.completed", { role: "user", text: `q${i}` }, `t${i}`);
  const page = control.viewPage("s", 2);
  assert.deepEqual(page.entries.map(e => e.key), ["t:t3", "t:t4"]);
  const older = control.viewPage("s", 2, page.entriesBefore!);
  assert.deepEqual(older.entries.map(e => e.key), ["t:t1", "t:t2"]);
  assert.equal(control.viewPage("s", 2, older.entriesBefore!).entriesBefore, null);
  assert.throws(() => control.viewChanges("s", page.viewRevision + 1, 0), /invalid_cursor/);
  done();
});

test("view work never touches the reply counter; the session carries its view revision", () => {
  const { control, append, done } = setup();
  append("a", "message.completed", { role: "assistant", text: "x" }, "t1");
  append("p", "progress", { phase: "thinking" }, "t1");
  control.reconcileReplayedEvent({ type: "session.event", sessionId: "s", eventId: "a", eventType: "message.completed", timestamp: 1,
    turnId: "t2", payload: { role: "assistant", text: "x" } });
  const session = control.session("s")!;
  assert.equal(session.messageCount, 1);
  assert.equal(typeof session.viewRevision, "number"); assert.equal(session.viewRevision, 3);
  done();
});

test("backfill keys existing events the way appends do", () => {
  const { store, control, append, done } = setup();
  append("u", "message.completed", { role: "user", text: "q" });
  append("x", "tool.completed", {}, undefined, "i");
  append("n", "approval.requested", {});
  append("u2", "message.completed", { role: "user", text: "q2" });
  append("t", "message.completed", { role: "assistant", text: "a" }, "t9");
  const live = store.db.prepare("SELECT event_id,view_key FROM events ORDER BY id").all();
  store.db.exec("UPDATE events SET view_key=NULL");
  backfillViewKeys(store.db);
  assert.deepEqual(store.db.prepare("SELECT event_id,view_key FROM events ORDER BY id").all(), live);
  assert.deepEqual(live.map(r => (r as { view_key: string }).view_key), ["o:u", "o:u", "n:n", "o:u2", "t:t9"]);
  assert.equal(control.viewPage("s", 10).entries.length, 4);
  done();
});

test("an oversized turn arrives as a window with a cursor to its older items", () => {
  const { control, append, done } = setup();
  for (let i = 0; i < 400; i++) append(`c${i}`, "command.completed", { command: `run ${i}`, output: "o".repeat(1800) }, "big", `call${i}`);
  const page = control.viewPage("s", 10);
  const entry = page.entries[0]!;
  assert.equal(entry.itemCount, 400); assert.ok(entry.items.length < 400); assert.ok(entry.itemsBefore);
  assert.ok(entry.items.every(i => i.truncated === undefined || i.truncated));
  const older = control.viewEntryItems("s", "t:big", entry.itemsBefore!)!;
  assert.equal(older.entry.items.at(-1)!.seq, entry.items[0]!.seq - 1);
  assert.equal(control.eventById("s", "c0")?.eventId, "c0");
  done();
});
