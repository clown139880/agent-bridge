import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArchiveOutbox, type ArchiveEvent } from "../apps/bridge/src/archive-outbox.js";

const event = (eventId: string): ArchiveEvent => ({ type: "session.event", sessionId: "s1", eventId,
  eventType: "message.completed", timestamp: 1, payload: { role: "assistant", text: eventId } } as unknown as ArchiveEvent);

const fail = (error: unknown) => { throw error; };

test("the archive outbox journal appends one line per mutation and replays after restart", () => {
  const path = join(tmpdir(), `archive-outbox-${randomUUID()}.jsonl`);
  try {
    const outbox = new ArchiveOutbox(path, 3, "m1", fail);
    for (const id of ["a", "b", "c"]) outbox.add(event(id));
    outbox.ack("b");
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 4);
    assert.deepEqual([...new ArchiveOutbox(path, 3, "m1", fail).messages.keys()], ["a", "c"]);
  } finally { rmSync(path, { force: true }); }
});

test("capacity drops report one growing gap and survive restart with the same survivors", () => {
  const path = join(tmpdir(), `archive-outbox-${randomUUID()}.jsonl`);
  try {
    const outbox = new ArchiveOutbox(path, 2, "m1", fail);
    for (const id of ["a", "b", "c", "d"]) outbox.add(event(id));
    assert.deepEqual([...outbox.messages.keys()], ["c", "d"]);
    assert.equal(outbox.gap?.firstEventId, "a");
    assert.equal(outbox.gap?.lastEventId, "b");
    assert.equal(outbox.gap?.droppedCount, 2);
    const reloaded = new ArchiveOutbox(path, 2, "m1", fail);
    assert.deepEqual([...reloaded.messages.keys()], ["c", "d"]);
    assert.equal(reloaded.gap?.droppedCount, 2);
    reloaded.ackGap(reloaded.gap!.gapId);
    assert.equal(new ArchiveOutbox(path, 2, "m1", fail).gap, undefined);
  } finally { rmSync(path, { force: true }); }
});

test("the journal compacts to live entries and still reads the old snapshot file", () => {
  const path = join(tmpdir(), `archive-outbox-${randomUUID()}.jsonl`);
  try {
    writeFileSync(path, JSON.stringify({ messages: [event("old")] }));
    const outbox = new ArchiveOutbox(path, 10, "m1", fail);
    assert.deepEqual([...outbox.messages.keys()], ["old"]);
    for (let index = 0; index < 3_000; index++) { outbox.add(event(`e${index}`)); outbox.ack(`e${index}`); }
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.ok(lines.length <= 1_025, `journal holds ${lines.length} lines`);
    assert.deepEqual([...new ArchiveOutbox(path, 10, "m1", fail).messages.keys()], ["old"]);
  } finally { rmSync(path, { force: true }); rmSync(`${path}.tmp`, { force: true }); }
});
