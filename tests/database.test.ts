import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../packages/database/src/index.js";

test("sessions can be resolved by machine and native Codex thread", () => {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  store.createSession({
    id: "thread-1", machineId: "dev", agentType: "codex-cli", projectName: "project",
    projectPath: "/tmp/project", matrixRoomId: "!room:test", matrixThreadId: null,
    nativeSessionId: "thread-1", status: "working", createdAt: 1, updatedAt: 1,
  });
  assert.equal(store.getSessionByNative("dev", "thread-1")?.id, "thread-1");
  store.db.close();
  rmSync(path, { force: true });
});

test("upstream event IDs are persisted idempotently", () => {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  store.createSession({
    id: "thread-1", machineId: "dev", agentType: "codex-desktop", projectName: "project",
    projectPath: "/tmp/project", matrixRoomId: "!room:test", matrixThreadId: null,
    nativeSessionId: "thread-1", status: "completed", createdAt: 1, updatedAt: 1,
  });
  const event = {
    type: "agent.completed" as const,
    eventId: "desktop:thread-1:turn-1:agent.completed",
    sessionId: "thread-1",
    timestamp: 2,
    summary: "done",
  };
  assert.equal(store.addEvent(event), true);
  assert.equal(store.addEvent(event), false);
  store.db.close();
  rmSync(path, { force: true });
});

test("existing databases gain the upstream event ID column and unique index", () => {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  legacy.close();

  const store = new Store(path);
  const columns = store.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const indexes = store.db.prepare("PRAGMA index_list(events)").all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === "event_id"), true);
  assert.equal(indexes.some((index) => index.name === "events_upstream_idx"), true);
  store.db.close();
  rmSync(path, { force: true });
});
