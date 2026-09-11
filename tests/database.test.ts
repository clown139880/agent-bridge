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
    CREATE TABLE worker_runs (
      id TEXT PRIMARY KEY, task_id TEXT, machine_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      project_path TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX worker_runs_session_idx ON worker_runs(session_id) WHERE session_id IS NOT NULL;
  `);
  legacy.close();

  const store = new Store(path);
  const columns = store.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  const indexes = store.db.prepare("PRAGMA index_list(events)").all() as Array<{ name: string }>;
  const workerColumns = store.db.prepare("PRAGMA table_info(worker_runs)").all() as Array<{ name: string }>;
  const workerIndexes = store.db.prepare("PRAGMA index_list(worker_runs)").all() as Array<{ name: string; unique: number }>;
  assert.equal(columns.some((column) => column.name === "event_id"), true);
  assert.equal(columns.some((column) => column.name === "worker_run_id"), true);
  assert.equal(indexes.some((index) => index.name === "events_upstream_idx"), true);
  assert.equal(workerColumns.some((column) => column.name === "conversation_id"), true);
  assert.equal(workerIndexes.find((index) => index.name === "worker_runs_session_idx")?.unique, 0);
  store.db.close();
  rmSync(path, { force: true });
});

test("sequential worker runs can share one Codex session while keeping events separate", () => {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  store.createSession({
    id: "thread-1", machineId: "dev", agentType: "codex-cli", projectName: "project",
    projectPath: "/tmp/project", matrixRoomId: "", matrixThreadId: null,
    nativeSessionId: "thread-1", status: "completed", createdAt: 1, updatedAt: 1,
  });
  for (const [id, createdAt] of [["run-1", 1], ["run-2", 2]] as const) {
    store.createWorkerRun({
      id, taskId: id, conversationId: "matrix-session", machineId: "dev", agentType: "codex-cli", projectPath: "/tmp/project",
      sessionId: "thread-1", status: id === "run-1" ? "completed" : "working", error: null,
      createdAt, updatedAt: createdAt,
    });
  }
  store.addEvent({
    type: "agent.completed", eventId: "event-2", sessionId: "thread-1", timestamp: 3, summary: "second",
  }, "run-2");

  assert.equal(store.getWorkerRunBySession("thread-1")?.id, "run-2");
  assert.equal(store.listEvents("thread-1", 0, 100, "run-1").length, 0);
  assert.equal(store.listEvents("thread-1", 0, 100, "run-2")[0]?.event.summary, "second");
  store.db.close();
  rmSync(path, { force: true });
});

test("a 0.4.2 database upgrades transactionally to the Agent Control schema", () => {
  const path=join(tmpdir(),`agent-bridge-042-${randomUUID()}.sqlite`),legacy=new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE machines (id TEXT PRIMARY KEY,name TEXT NOT NULL,platform TEXT NOT NULL,hostname TEXT NOT NULL,status TEXT NOT NULL,capabilities TEXT NOT NULL,last_seen_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES machines(id),agent_type TEXT NOT NULL,project_name TEXT NOT NULL,project_path TEXT NOT NULL,matrix_room_id TEXT NOT NULL,matrix_thread_id TEXT,native_session_id TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id),event_id TEXT,worker_run_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE worker_runs (id TEXT PRIMARY KEY,task_id TEXT,conversation_id TEXT,machine_id TEXT NOT NULL REFERENCES machines(id),agent_type TEXT NOT NULL,project_path TEXT NOT NULL,session_id TEXT REFERENCES sessions(id),status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    INSERT INTO machines VALUES ('dev','dev','linux','dev','online','["codex-cli"]',1,1);
    INSERT INTO sessions VALUES ('thread','dev','codex-cli','repo','/work/repo','',NULL,'thread','completed',1,2);
  `);legacy.close();
  const store=new Store(path);
  const version=store.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {version:number};
  assert.equal(version.version,6);
  const tables=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name);
  for(const table of ["pending_requests","actions","idempotency_keys","stream_events","deleted_sessions","attachments","deleted_workers"])assert.ok(tables.includes(table));
  const session=store.db.prepare("SELECT activity_status,source,last_response_at,updated_at FROM sessions WHERE id='thread'").get() as any;
  assert.equal(session.activity_status,"idle");assert.equal(session.source,"app-server");
  assert.equal(session.last_response_at,null);assert.equal(session.updated_at,1);
  // Reopening proves the versioned migration is idempotent.
  store.db.close();const reopened=new Store(path);assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as any).n,7);
  reopened.db.close();rmSync(path,{force:true});
});
