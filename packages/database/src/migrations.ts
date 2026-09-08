import type { DatabaseSync } from "node:sqlite";

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function addColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export function migrateDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, hostname TEXT NOT NULL,
      status TEXT NOT NULL, capabilities TEXT NOT NULL, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id), agent_type TEXT NOT NULL,
      project_name TEXT NOT NULL, project_path TEXT NOT NULL, matrix_room_id TEXT NOT NULL,
      matrix_thread_id TEXT, native_session_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_thread_idx ON sessions(matrix_room_id, matrix_thread_id);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_idx ON sessions(machine_id, native_session_id)
      WHERE native_session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), event_id TEXT,
      worker_run_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_runs (
      id TEXT PRIMARY KEY, task_id TEXT, conversation_id TEXT, machine_id TEXT NOT NULL REFERENCES machines(id),
      agent_type TEXT NOT NULL, project_path TEXT NOT NULL, session_id TEXT REFERENCES sessions(id),
      status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    );
  `);

  // Version 0 captures compatibility upgrades from older pre-versioned schemas through 0.4.2.
  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=0").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn(db, "events", "worker_run_id", "TEXT");
      addColumn(db, "events", "event_id", "TEXT");
      addColumn(db, "worker_runs", "conversation_id", "TEXT");
      db.exec(`
        UPDATE events SET worker_run_id = (
          SELECT id FROM worker_runs WHERE worker_runs.session_id = events.session_id
          ORDER BY worker_runs.created_at DESC LIMIT 1
        ) WHERE worker_run_id IS NULL;
        DROP INDEX IF EXISTS worker_runs_session_idx;
        CREATE INDEX IF NOT EXISTS worker_runs_session_idx ON worker_runs(session_id);
        CREATE UNIQUE INDEX IF NOT EXISTS events_upstream_idx ON events(session_id, event_id)
          WHERE event_id IS NOT NULL;
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (0,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }

  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version=1").get();
  if (!applied) {
    db.exec("BEGIN IMMEDIATE");
    try {
    addColumn(db, "machines", "bridge_version", "TEXT");
    addColumn(db, "machines", "protocol_version", "INTEGER");
    addColumn(db, "machines", "features_json", "TEXT");
    addColumn(db, "machines", "connected_at", "INTEGER");
    addColumn(db, "sessions", "title", "TEXT");
    addColumn(db, "sessions", "prompt_summary", "TEXT");
    addColumn(db, "sessions", "source", "TEXT NOT NULL DEFAULT 'app-server'");
    addColumn(db, "sessions", "history_completeness", "TEXT NOT NULL DEFAULT 'loaded-only'");
    addColumn(db, "sessions", "activity_status", "TEXT");
    addColumn(db, "sessions", "active_turn_id", "TEXT");
    addColumn(db, "sessions", "last_turn_status", "TEXT");
    addColumn(db, "sessions", "last_error", "TEXT");
    addColumn(db, "sessions", "inventory_seen_at", "INTEGER");
    addColumn(db, "events", "turn_id", "TEXT");
    addColumn(db, "events", "item_id", "TEXT");
    addColumn(db, "events", "event_schema", "INTEGER NOT NULL DEFAULT 1");
    db.exec(`
      CREATE TABLE pending_requests (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
        worker_run_id TEXT, turn_id TEXT, machine_id TEXT NOT NULL, status TEXT NOT NULL,
        request_json TEXT NOT NULL, decision_json TEXT, requested_at INTEGER NOT NULL, resolved_at INTEGER,
        upstream_request_id TEXT NOT NULL, resolving_action_id TEXT,
        UNIQUE(machine_id, upstream_request_id)
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, kind TEXT NOT NULL, machine_id TEXT NOT NULL,
        session_id TEXT, turn_id TEXT, status TEXT NOT NULL, resolved_action TEXT, result_json TEXT,
        error_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE idempotency_keys (
        principal TEXT NOT NULL, key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
        request_hash TEXT NOT NULL, action_id TEXT NOT NULL REFERENCES actions(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(principal, key)
      );
      CREATE TABLE stream_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_updated_idx ON sessions(updated_at, id);
      CREATE INDEX sessions_machine_activity_idx ON sessions(machine_id, activity_status, updated_at, id);
      CREATE INDEX worker_runs_session_created_idx ON worker_runs(session_id, created_at, id);
      CREATE INDEX worker_runs_task_idx ON worker_runs(task_id, created_at, id);
      CREATE INDEX worker_runs_conversation_idx ON worker_runs(conversation_id, created_at, id);
      CREATE INDEX events_session_id_idx ON events(session_id, id);
      CREATE INDEX pending_status_idx ON pending_requests(status, requested_at, id);
      CREATE INDEX actions_expiry_idx ON actions(expires_at);
      CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at);
      CREATE INDEX stream_created_idx ON stream_events(created_at, sequence);
      UPDATE sessions SET activity_status = CASE status
        WHEN 'working' THEN 'active' WHEN 'blocked' THEN 'waiting_for_approval'
        WHEN 'waiting' THEN 'idle' WHEN 'failed' THEN 'error' ELSE 'idle' END
        WHERE activity_status IS NULL;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, ${Date.now()});
    `);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }
  const applied2 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get();
  if (!applied2) {
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn(db, "pending_requests", "resolving_action_id", "TEXT");
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (2,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  const applied3 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get();
  if (!applied3) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE deleted_sessions (
          session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, deleted_at INTEGER NOT NULL
        );
        CREATE INDEX deleted_sessions_machine_idx ON deleted_sessions(machine_id, deleted_at);
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (3,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  const applied4 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get();
  if (!applied4) {
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn(db, "sessions", "last_response_at", "INTEGER");
      db.exec(`
        UPDATE sessions SET last_response_at = (
          SELECT MAX(events.created_at) FROM events
          WHERE events.session_id = sessions.id AND events.event_schema = 2 AND (
            (events.type = 'message.completed' AND json_extract(CASE WHEN json_valid(events.payload) THEN events.payload ELSE '{}' END, '$.payload.role') = 'assistant')
            OR (events.type = 'turn.completed' AND COALESCE(json_extract(CASE WHEN json_valid(events.payload) THEN events.payload ELSE '{}' END, '$.payload.summary'), '') <> '')
          )
        );
        UPDATE sessions SET updated_at = COALESCE(last_response_at, created_at);
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (4,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
}
