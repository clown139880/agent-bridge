import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CoalescedFileWriter } from "../apps/bridge/src/coalesced-writer.js";

function tmpPath(): string {
  return join(tmpdir(), `coalesced-writer-${randomUUID()}.json`);
}

test("coalesces a burst of mutations into a single write with the latest snapshot", async () => {
  const path = tmpPath();
  let writes = 0;
  const writer = new CoalescedFileWriter(path, 20, () => {});
  try {
    // Simulate a burst: 500 rapid mutations of a growing buffer.
    for (let i = 0; i < 500; i++) {
      writer.schedule(() => {
        writes++;
        return JSON.stringify({ n: i });
      });
    }
    // Nothing on disk yet — the write is deferred to the trailing edge.
    assert.equal(existsSync(path), false);
    await delay(60);
    // The whole burst collapsed into exactly one physical write...
    assert.equal(writes, 1);
    // ...persisting the most recent state, not an intermediate one.
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { n: 499 });
  } finally {
    rmSync(path, { force: true });
  }
});

test("flushSync persists immediately for graceful shutdown", () => {
  const path = tmpPath();
  const writer = new CoalescedFileWriter(path, 10_000, () => {});
  try {
    writer.schedule(() => JSON.stringify({ ready: true }));
    assert.equal(existsSync(path), false);
    writer.flushSync();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ready: true });
    // A second flush with nothing pending is a no-op (does not throw or rewrite).
    writer.flushSync();
  } finally {
    rmSync(path, { force: true });
  }
});

test("separate windows each produce their own write", async () => {
  const path = tmpPath();
  let writes = 0;
  const writer = new CoalescedFileWriter(path, 15, () => {
    throw new Error("unexpected write error");
  });
  try {
    writer.schedule(() => { writes++; return JSON.stringify({ v: 1 }); });
    await delay(40);
    writer.schedule(() => { writes++; return JSON.stringify({ v: 2 }); });
    await delay(40);
    assert.equal(writes, 2);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { v: 2 });
  } finally {
    rmSync(path, { force: true });
  }
});

test("surfaces write failures through the error callback without throwing", async () => {
  // A path whose parent cannot be created (a file exists where a dir is needed).
  const file = tmpPath();
  const writer = new CoalescedFileWriter(join(file, "child.json"), 10, () => {});
  const errors: unknown[] = [];
  const guarded = new CoalescedFileWriter(join(file, "child.json"), 10, (e) => errors.push(e));
  try {
    rmSync(file, { force: true });
    // Create a regular file so mkdir of `${file}/` fails.
    (await import("node:fs")).writeFileSync(file, "x");
    guarded.schedule(() => JSON.stringify({ nope: true }));
    guarded.flushSync();
    assert.equal(errors.length, 1);
    void writer;
  } finally {
    rmSync(file, { force: true });
  }
});
