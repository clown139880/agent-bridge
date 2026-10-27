import assert from "node:assert/strict";
import test from "node:test";
import { canonicalItem, contentMark, entryLive, projectEntry, trimEvent, viewKey, windowEntry, type PreviousContent, type WireEvent } from "../packages/transcript/src/index.js";

type Row = WireEvent & { seq: number };
const row = (seq: number, type: string, payload: Record<string, unknown> = {}, turnId: string | null = "one", itemId?: string, eventId = `e${seq}`): Row =>
  ({ seq, eventId, cursor: `e:${seq}`, sessionId: "s", type, turnId, itemId: itemId ?? null, timestamp: seq * 1000, payload });
const project = (rows: Row[], superseded = false) => projectEntry({ key: rows[0]!.turnId ? `t:${rows[0]!.turnId}` : `o:${rows[0]!.eventId}`, events: rows, superseded });

/** Keys every row the way the store does: in order, from the previous content row. */
function keys(rows: Row[]) {
  let previous: PreviousContent | undefined;
  return rows.map(r => {
    const key = viewKey(r, previous);
    previous = contentMark(r, key) ?? previous;
    return key;
  });
}

test("a turn keeps prompts, process and exactly one final reply", () => {
  const view = project([row(1, "turn.started"), row(2, "message.completed", { role: "user", text: "hi" }),
    row(3, "message.completed", { role: "assistant", text: "checking" }), row(4, "tool.started", {}, "one", "call"),
    row(5, "command.completed", { command: "ls", exitCode: 0 }, "one", "call"), row(6, "message.completed", { role: "assistant", text: "done" }),
    row(7, "turn.completed")]);
  assert.equal(view.status, "completed"); assert.equal(view.durationMs, 6000); assert.equal(view.partial, false);
  assert.deepEqual(view.items.map(i => [i.itemId, i.role]), [["step:e2", "prompt"], ["step:e3", "process"], ["step:e4", "process"], ["step:e6", "final"]]);
  assert.equal(view.items[2]!.event.type, "command.completed", "a tool shows its result at its starting position");
});

test("a late tool.started never takes a tool back from its result", () => {
  const view = project([row(1, "command.completed", { exitCode: 0 }, "one", "call"), row(2, "tool.started", {}, "one", "call")]);
  assert.equal(view.items.length, 1); assert.equal(view.items[0]!.event.type, "command.completed");
});

test("a late tool moves an earlier reply back into the process", () => {
  const before = project([row(1, "message.completed", { role: "assistant", text: "answer" })]);
  assert.equal(before.items[0]!.role, "final");
  const after = project([row(1, "message.completed", { role: "assistant", text: "answer" }), row(2, "tool.completed", {}, "one", "x")]);
  assert.deepEqual(after.items.map(i => i.role), ["process", "process"]);
});

test("a steering prompt starts a segment in place, each segment with its own final", () => {
  const view = project([row(1, "message.completed", { role: "user", text: "a" }), row(2, "message.completed", { role: "assistant", text: "r1" }),
    row(3, "message.completed", { role: "user", text: "b" }), row(4, "message.completed", { role: "user", text: "c" }),
    row(5, "message.completed", { role: "assistant", text: "r2" })]);
  assert.deepEqual(view.items.map(i => [i.segment, i.role]), [[0, "prompt"], [0, "final"], [1, "prompt"], [1, "prompt"], [1, "final"]]);
});

test("item ids are reused in other turns and under other parents without merging", () => {
  const view = project([row(1, "task.started", {}, "one", "task"), row(2, "tool.completed", { parentItemId: "task" }, "one", "call"),
    row(3, "tool.completed", {}, "one", "call"), row(4, "task.completed", { status: "completed" }, "one", "task")]);
  assert.deepEqual(view.items.map(i => [i.itemId, i.parentItemId]), [["step:e1", null], ["step:e2", "step:e1"], ["step:e3", null]]);
  assert.equal(view.items[0]!.event.type, "task.completed");
});

test("live and history ids of one App Server item merge", () => {
  assert.equal(canonicalItem({ eventId: "app-server:th:turn:item7:message" }), "item7");
  assert.equal(canonicalItem({ eventId: "app-server:th:item7:history-message" }), "item7");
  const view = project([row(1, "message.completed", { role: "assistant", text: "a" }, "one", null as never, "app-server:th:item7:history-message"),
    row(2, "message.completed", { role: "assistant", text: "a2" }, "one", "item7", "app-server:th:turn:item7:message")]);
  assert.equal(view.items.length, 1); assert.equal(view.items[0]!.event.payload.text, "a2");
});

test("closure is evidence: a superseded turn is not completed, output after a terminal is counted", () => {
  const superseded = project([row(1, "turn.started"), row(2, "tool.completed", {}, "one", "x")], true);
  assert.equal(superseded.status, "unknown"); assert.equal(superseded.closure.kind, "superseded");
  const late = project([row(1, "turn.started"), row(2, "turn.completed"), row(3, "command.completed", {}, "one", "y"),
    row(4, "message.completed", { role: "assistant", text: "more" })]);
  assert.equal(late.status, "completed"); assert.equal(late.closure.kind, "terminal"); assert.equal(late.eventsAfterTerminal, 2);
  const revised = project([row(1, "turn.completed"), row(2, "turn.failed", { error: "x" })]);
  assert.equal(revised.status, "failed");
});

test("progress only sets a phase, cleared by later output", () => {
  assert.equal(project([row(1, "message.completed", { role: "user", text: "q" }), row(2, "progress", { phase: "thinking" })]).lastPhase, "thinking");
  assert.equal(project([row(1, "progress", { phase: "thinking" }), row(2, "message.completed", { role: "assistant", text: "a" })]).lastPhase, null);
  assert.equal(project([row(1, "progress", { phase: "thinking" }), row(2, "message.completed", { role: "assistant", text: "a" })]).items.length, 1);
});

test("view keys: turns by id, turnless content in runs split at prompts, metadata never splits", () => {
  const rows = [row(1, "message.completed", { role: "user", text: "a" }, null), row(2, "context.updated", {}, null),
    row(3, "tool.completed", {}, null, "x"), row(4, "approval.requested", {}, null), row(5, "message.completed", { role: "assistant", text: "r" }, null),
    row(6, "message.completed", { role: "user", text: "b" }, null), row(7, "message.completed", { role: "user", text: "c" }, null),
    row(8, "message.completed", { role: "assistant", text: "r" }, "t1"), row(9, "message.completed", { role: "assistant", text: "r" }, null)];
  assert.deepEqual(keys(rows), ["o:e1", null, "o:e1", "n:e4", "o:e1", "o:e6", "o:e6", "t:t1", "o:e9"]);
});

test("trimmed payloads keep message text and mark tool previews", () => {
  const big = "x".repeat(10_000);
  assert.equal(trimEvent(row(1, "message.completed", { role: "assistant", text: big })).truncated, false);
  const tool = trimEvent(row(1, "command.completed", { output: big }));
  assert.equal(tool.truncated, true); assert.equal(String(tool.event.payload.output).length, 2048);
});

test("windows keep the latest items within budget and always advance", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, "command.completed", { output: "y".repeat(1500) }, "one", `c${i}`));
  const view = windowEntry(project(rows), 20_000);
  assert.ok(view.items.length > 0 && view.items.length < 50); assert.equal(view.items.at(-1)!.seq, 50);
  assert.equal(view.itemsBefore, view.items[0]!.seq);
  const older = windowEntry(project(rows), 20_000, view.itemsBefore!);
  assert.equal(older.items.at(-1)!.seq, view.items[0]!.seq - 1);
  assert.equal(windowEntry(project([row(1, "command.completed", { output: "z".repeat(1500) }, "one", "a")]), 10).items.length, 1);
});

test("live comes from the session resource", () => {
  assert.equal(entryLive({ turnId: "one" }, { activeTurnId: "one", status: "active" }), true);
  assert.equal(entryLive({ turnId: "one" }, { activeTurnId: "one", status: "idle" }), false);
});

test("the client model merges by revision, never revives removed entries and counts raw events once", async () => {
  const { ConversationModel } = await import("../packages/transcript/src/index.js");
  const entry = (key: string, anchor: number, rev: number, text = key) => ({ ...project([row(anchor, "message.completed", { role: "assistant", text }, key.slice(2))]), key, anchor, rev });
  const model = ConversationModel.fromPage({ projectionVersion: 1, viewRevision: 10, orderingEpoch: 0, rawHigh: 100,
    entries: [entry("t:b", 50, 9), entry("t:c", 60, 10)], entriesBefore: "v:0:50" });
  const changes = (from: number, to: number, entries: ReturnType<typeof entry>[], removed: Array<{ key: string; rev: number }> = [], raw = { after: 100, through: 103, count: 3 }) =>
    ({ projectionVersion: 1, fromRevision: from, toRevision: to, hasMore: false, orderingEpoch: 0, entries, removed, raw });
  assert.deepEqual(model.applyChanges(changes(10, 12, [entry("t:c", 60, 12, "new"), entry("t:a", 10, 11)], [{ key: "t:b", rev: 12 }])), { kind: "applied", newRawEvents: 3 });
  assert.deepEqual(model.list().map(e => e.key), ["t:c"], "an entry before the loaded floor waits for its page; a removed one goes");
  assert.equal(model.applyChanges(changes(10, 12, [])).kind, "stale", "an overtaken response is ignored");
  assert.deepEqual(model.applyChanges(changes(12, 13, [], [], { after: 100, through: 103, count: 3 })), { kind: "applied", newRawEvents: 0 }, "a repeated range is not counted again");
  model.applyOlder({ projectionVersion: 1, viewRevision: 99, orderingEpoch: 0, rawHigh: 999, entries: [entry("t:a", 10, 11), entry("t:b", 50, 9)], entriesBefore: null });
  assert.deepEqual(model.list().map(e => e.key), ["t:a", "t:c"], "an older page cannot revive a removed entry");
  assert.equal(model.viewRevision, 13); assert.equal(model.rawHigh, 103);
  assert.equal(model.applyChanges({ ...changes(13, 14, []), orderingEpoch: 1 }).kind, "reset");
});
