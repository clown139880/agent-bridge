import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { AgentControlStore, Store } from "../packages/database/src/index.js";

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
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  const event = { type: "session.event" as const, eventType: "turn.completed" as const,
    eventId: "desktop:thread-1:turn-1:turn.completed", sessionId: "thread-1", timestamp: 2, payload: { summary: "done" } };
  assert.equal(typeof control.appendSessionEvent(event), "number");
  assert.equal(control.appendSessionEvent(event), false);
  store.db.close();
  rmSync(path, { force: true });
});

test("legacy sessions inherit only a unanimous repository identity from the same machine and workspace", () => {
  const path = join(tmpdir(), `agent-bridge-project-identity-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  const create = (id: string, projectPath: string) => store.createSession({
    id, machineId: "dev", agentType: "codex-cli", projectName: "project", projectPath,
    matrixRoomId: "", matrixThreadId: null, nativeSessionId: id, status: "completed", createdAt: 1, updatedAt: 1,
  });
  create("known", "/work/repo");
  create("legacy", "/work/repo");
  create("conflict-a", "/work/conflict");
  create("conflict-b", "/work/conflict");
  create("conflict-legacy", "/work/conflict");
  store.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?").run("github.com/example/repo", "known");
  store.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?").run("github.com/example/first", "conflict-a");
  store.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?").run("github.com/example/second", "conflict-b");
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  assert.equal(control.session("legacy")?.projectIdentity, "github.com/example/repo");
  assert.equal(control.session("conflict-legacy")?.projectIdentity, undefined);
  store.db.close();
  rmSync(path, { force: true });
});

test("presentation groups are server-owned, stably ordered, and paged without splitting sessions", () => {
  const path = join(tmpdir(), `agent-bridge-presentation-${randomUUID()}.sqlite`);
  const store = new Store(path);
  for (const id of ["dev", "win"]) store.upsertMachine({ id, name: id, platform: "linux", hostname: id, capabilities: [] });
  const create = (id:string,machineId:string,projectPath:string,updatedAt:number,identity?:string) => {
    store.createSession({id,machineId,agentType:"codex-cli",projectName:projectPath.split(/[\\/]/).at(-1)!,projectPath,
      matrixRoomId:"",matrixThreadId:null,nativeSessionId:id,status:"completed",createdAt:1,updatedAt});
    if(identity)store.db.prepare("UPDATE sessions SET project_identity=? WHERE id=?").run(identity,id);
  };
  create("repo-old","dev","/work/repo",400,"github.com/example/repo");
  create("repo-new","win","D:\\repo",500,"github.com/example/repo");
  create("plain-b","dev","/work/plain",300);
  create("plain-a","dev","/work/plain",300);
  create("other","win","D:\\other",100);
  const control=new AgentControlStore(store.db,{actionsMs:1_000,attachmentsMs:1_000});
  const first=control.listSessionGroups({limit:1});
  assert.equal(first.hasMore,true);assert.ok(first.nextCursor);
  assert.equal(first.data[0]!.kind,"repository");
  assert.equal(first.data[0]!.projectIdentity,"github.com/example/repo");
  assert.deepEqual((first.data[0]!.sessions as any[]).map(row=>row.sessionId),["repo-new","repo-old"]);
  assert.equal((first.data[0]!.executionLocations as any[]).length,2);
  const stableId=first.data[0]!.groupId;
  assert.equal(control.listSessionGroups({limit:1}).data[0]!.groupId,stableId);
  const second=control.listSessionGroups({limit:1,cursor:first.nextCursor!});
  assert.deepEqual((second.data[0]!.sessions as any[]).map(row=>row.sessionId),["plain-a","plain-b"]);
  assert.equal(second.data[0]!.kind,"location");
  assert.equal(control.session("repo-old")?.groupId,stableId);
  store.db.close();rmSync(path,{force:true});
});

test("official session deletion removes its events and search rows without relying on foreign keys", () => {
  const path = join(tmpdir(), `agent-bridge-delete-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  for (const id of ["thread-1", "thread-2"]) store.createSession({
    id, machineId: "dev", agentType: "codex-cli", projectName: "project",
    projectPath: "/tmp/project", matrixRoomId: "", matrixThreadId: null,
    nativeSessionId: id, status: "completed", createdAt: 1, updatedAt: 1,
  });
  store.db.exec("PRAGMA foreign_keys=OFF");
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  for (const sessionId of ["thread-1", "thread-2"]) control.appendSessionEvent({ type: "session.event",
    eventType: "message.completed", eventId: "event-1", sessionId, timestamp: 1, payload: { role: "user", text: "remember me" } });
  assert.equal(control.deleteSession("thread-1"), true);
  const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
  assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE id='thread-1'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE session_id='thread-1'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM event_search WHERE event_search MATCH 'remember'"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM deleted_sessions WHERE session_id='thread-1'"), 1);
  const position = control.streamPosition();
  const delivered = control.streamAfter({ events: position.events, changes: position.changes - 1 }).items;
  assert.deepEqual(delivered.map((item) => [item.type, item.resourceId]), [["session.deleted", "thread-1"]]);
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
  new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 }).appendSessionEvent({ type: "session.event",
    eventType: "turn.completed", eventId: "event-2", sessionId: "thread-1", timestamp: 3, payload: { summary: "second" } });

  assert.equal(store.getWorkerRunBySession("thread-1")?.id, "run-2");
  assert.equal(store.listRunEvents("thread-1", "run-1").events.length, 0);
  assert.equal((store.listRunEvents("thread-1", "run-2").events[0]?.event as { summary?: string }).summary, "second");
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
  assert.equal(version.version,8);
  const tables=(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name);
  for(const table of ["pending_requests","actions","idempotency_keys","stream_changes","event_search","deleted_sessions","attachments",
    "deleted_workers","conversation_collection_gaps"])
    assert.ok(tables.includes(table));
  for(const table of ["stream_events","conversation_messages","conversation_messages_fts","conversation_archive_chunks"])
    assert.ok(!tables.includes(table));
  const session=store.db.prepare("SELECT activity_status,source,last_response_at,updated_at FROM sessions WHERE id='thread'").get() as any;
  assert.equal(session.activity_status,"idle");assert.equal(session.source,"app-server");
  assert.equal(session.last_response_at,null);assert.equal(session.updated_at,1);
  // Reopening proves the versioned migration is idempotent.
  store.db.close();const reopened=new Store(path);assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as any).n,9);
  reopened.db.close();rmSync(path,{force:true});
});

test("version 8 folds every retained copy into one event row per upstream event", () => {
  const path=join(tmpdir(),`agent-bridge-v8-${randomUUID()}.sqlite`);
  // Build a version-7 database: mark 8 applied, fill v7 tables, then unmark it and reopen.
  const seed=new DatabaseSync(path);
  seed.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (8,0)");
  seed.close();
  const v7=new Store(path);
  v7.upsertMachine({id:"dev",name:"dev",platform:"linux",hostname:"dev",capabilities:[]});
  v7.createSession({id:"thread",machineId:"dev",agentType:"codex-cli",projectName:"repo",projectPath:"/work/repo",
    matrixRoomId:"",matrixThreadId:null,nativeSessionId:"thread",status:"completed",createdAt:1,updatedAt:1});
  const envelope=(eventId:string,type:string,payload:unknown)=>JSON.stringify({eventId,type,sessionId:"thread",timestamp:5,payload});
  v7.db.prepare("INSERT INTO sqlite_sequence(name,seq) SELECT 'events',10 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='events')").run();
  v7.db.prepare("UPDATE sqlite_sequence SET seq=10 WHERE name='events'").run();
  const insertEvent=v7.db.prepare(`INSERT INTO events(session_id,event_id,worker_run_id,type,turn_id,item_id,payload,created_at,event_schema)
    VALUES ('thread',?,NULL,?,'turn-1',?,?,?,?)`);
  insertEvent.run("reply","message.completed","answer",envelope("reply","message.completed",{role:"assistant",text:"kept reply"}),5,2);
  const output="x".repeat(4_000);
  insertEvent.run("cmd","command.completed","cmd",envelope("cmd","command.completed",{command:"make",output,status:"completed"}),6,2);
  insertEvent.run(null,"agent.completed",null,JSON.stringify({summary:"legacy"}),7,1);
  const lastId=Number(insertEvent.run("dropped","progress",null,envelope("dropped","progress",{}),8,2).lastInsertRowid);
  v7.db.prepare("DELETE FROM events WHERE id=?").run(lastId);
  v7.db.prepare(`INSERT INTO conversation_messages(message_id,session_id,source_instance,source_session_id,source_event_id,role,
    content,content_sha256,content_chars,occurred_at,collected_at,storage_state) VALUES
    ('m1','thread','dev','thread','reply','assistant','kept reply','h',10,5,5,'hot'),
    ('m2','thread','dev','thread','cold','user',NULL,'h',11,4,4,'cold')`).run();
  const cold=Number((v7.db.prepare("SELECT sequence FROM conversation_messages WHERE message_id='m2'").get() as {sequence:number}).sequence);
  v7.db.prepare("INSERT INTO conversation_messages_fts(rowid,content) VALUES (?,?)").run(cold,"cold prompt");
  v7.db.prepare("INSERT INTO stream_events(event_id,type,resource_kind,resource_id,payload,created_at) VALUES ('s','x','session','thread','{}',1)").run();
  v7.db.prepare("DELETE FROM schema_migrations WHERE version=8").run();
  v7.db.close();

  const store=new Store(path);
  const rows=store.db.prepare("SELECT id,event_id,type,body FROM events ORDER BY id").all() as Array<{id:number;event_id:string;type:string;body:unknown}>;
  // The restored original predates the retained events, so it reads first.
  assert.deepEqual(rows.map(row=>row.event_id),["cold","reply","cmd"]);
  assert.deepEqual(JSON.parse(String(rows[0]!.body)),{role:"user",text:"cold prompt",restored:true});
  assert.deepEqual(JSON.parse(String(rows[1]!.body)),{role:"assistant",text:"kept reply"});
  assert.ok(rows[2]!.body instanceof Uint8Array);
  assert.equal(JSON.parse(gunzipSync(rows[2]!.body as Uint8Array).toString()).output,output);
  // New ids never reuse one a client may already hold as a cursor.
  const control=new AgentControlStore(store.db,{actionsMs:1_000,attachmentsMs:1_000});
  const next=control.appendSessionEvent({type:"session.event",eventType:"progress",eventId:"after",sessionId:"thread",timestamp:9,payload:{}});
  assert.ok(Number(next)>lastId);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM event_search WHERE event_search MATCH 'cold prompt'").get() as {n:number}).n,1);
  store.db.close();rmSync(path,{force:true});
});

test("tool progress touches a session's updated_at without counting as a reply", () => {
  const path = join(tmpdir(), `agent-bridge-${randomUUID()}.sqlite`);
  const store = new Store(path);
  store.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: [] });
  store.createSession({
    id: "thread-1", machineId: "dev", agentType: "claude-code", projectName: "project",
    projectPath: "/tmp/project", matrixRoomId: "", matrixThreadId: null,
    nativeSessionId: "thread-1", status: "working", createdAt: 1, updatedAt: 1,
  });
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  const row = () => store.db.prepare("SELECT updated_at,last_response_at FROM sessions WHERE id='thread-1'").get() as
    { updated_at: number; last_response_at: number | null };
  control.appendSessionEvent({ type: "session.event", eventType: "command.completed", eventId: "cmd", sessionId: "thread-1",
    turnId: "turn-1", timestamp: 5, payload: { command: "ls", status: "completed" } });
  assert.deepEqual({ ...row() }, { updated_at: 5, last_response_at: null });
  control.appendSessionEvent({ type: "session.event", eventType: "file_change.completed", eventId: "edit", sessionId: "thread-1",
    turnId: "turn-1", timestamp: 7, payload: { changes: [], status: "completed" } });
  assert.equal(row().updated_at, 7);
  // A late (replayed) tool event never moves updated_at backwards.
  control.appendSessionEvent({ type: "session.event", eventType: "command.completed", eventId: "old", sessionId: "thread-1",
    turnId: "turn-0", timestamp: 3, payload: { command: "pwd", status: "completed" } });
  assert.equal(row().updated_at, 7);
  store.db.close();
  rmSync(path, { force: true });
});
