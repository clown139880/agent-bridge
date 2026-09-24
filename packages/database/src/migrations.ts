import type { DatabaseSync } from "node:sqlite";
import { decodeEventBody, encodeEventBody, indexEvent } from "./events.js";

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
  const applied5 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get();
  if (!applied5) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, filename TEXT NOT NULL,
          size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX attachments_created_idx ON attachments(created_at);
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (5,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  const applied6 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get();
  if (!applied6) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec('CREATE TABLE deleted_workers (worker_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(6,?)').run(Date.now());
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  const applied7 = db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get();
  if (!applied7) {
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn(db, "sessions", "project_identity", "TEXT");
      addColumn(db, "machines", "shared_skills_json", "TEXT");
      db.exec(`
        CREATE INDEX sessions_project_identity_idx ON sessions(project_identity, updated_at);
        CREATE INDEX sessions_machine_path_idx ON sessions(machine_id, project_path, updated_at);

        CREATE TABLE conversation_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_instance TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          content_sha256 TEXT NOT NULL,
          content_chars INTEGER NOT NULL,
          occurred_at INTEGER NOT NULL,
          collected_at INTEGER NOT NULL,
          turn_id TEXT,
          item_id TEXT,
          storage_state TEXT NOT NULL DEFAULT 'hot',
          archive_chunk_id TEXT,
          completeness TEXT NOT NULL DEFAULT 'complete',
          UNIQUE(source_instance, source_session_id, source_event_id)
        );
        CREATE INDEX conversation_messages_session_idx ON conversation_messages(session_id, sequence);
        CREATE INDEX conversation_messages_time_idx ON conversation_messages(occurred_at, sequence);
        CREATE INDEX conversation_messages_storage_idx ON conversation_messages(storage_state, occurred_at);

        CREATE TABLE conversation_source_aliases (
          source_instance TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          message_id TEXT NOT NULL REFERENCES conversation_messages(message_id) ON DELETE CASCADE,
          PRIMARY KEY(source_instance, source_session_id, source_event_id)
        );

        CREATE TABLE conversation_archive_chunks (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL UNIQUE,
          first_sequence INTEGER NOT NULL,
          last_sequence INTEGER NOT NULL,
          message_count INTEGER NOT NULL,
          uncompressed_bytes INTEGER NOT NULL,
          compressed_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE conversation_summaries (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          through_sequence INTEGER NOT NULL,
          source_version TEXT NOT NULL,
          generator_version TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          stale INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE conversation_collection_gaps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gap_id TEXT NOT NULL UNIQUE,
          source_instance TEXT NOT NULL,
          first_event_id TEXT,
          last_event_id TEXT,
          dropped_count INTEGER NOT NULL,
          reason TEXT NOT NULL,
          reported_at INTEGER NOT NULL
        );

        CREATE TABLE conversation_cleanup_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
          content, tokenize='unicode61 remove_diacritics 2'
        );
        CREATE VIRTUAL TABLE conversation_messages_fts_trigram USING fts5(
          content, tokenize='trigram'
        );
      `);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (7,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }

  if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrateToSingleEventStore(db);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (8,?)").run(Date.now());
      db.exec("COMMIT");
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    // Return the pages of every dropped copy to the filesystem once.
    db.exec("VACUUM");
  }
}

/**
 * Version 8 makes `events` the single permanent history. Each row stores only the
 * upstream body; the wire envelope is rebuilt from columns on read. Every other
 * copy (full-envelope payloads, stream snapshots, conversation message bodies,
 * content-bearing FTS tables, archives, summaries) is folded back or dropped.
 */
function migrateToSingleEventStore(db: DatabaseSync): void {
  const highWater = Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as
    { seq: number } | undefined)?.seq ?? 0);
  db.exec(`
    CREATE TABLE events_v8 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id TEXT NOT NULL, worker_run_id TEXT, type TEXT NOT NULL, turn_id TEXT, item_id TEXT,
      created_at INTEGER NOT NULL, body BLOB NOT NULL
    );
    INSERT INTO events_v8(id,session_id,event_id,worker_run_id,type,turn_id,item_id,created_at,body)
      SELECT id,session_id,event_id,worker_run_id,type,turn_id,item_id,created_at,
        COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.payload') END,'{}')
      FROM events WHERE event_schema=2 AND event_id IS NOT NULL;
  `);
  // Conversation memory outlived event retention for some bodies; those originals
  // become ordinary events again so a single table holds all history.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_messages'").get()) {
    const lost = db.prepare(`SELECT m.session_id,m.source_event_id,m.role,m.turn_id,m.item_id,m.occurred_at,
        COALESCE(m.content,(SELECT content FROM conversation_messages_fts f WHERE f.rowid=m.sequence)) AS content
      FROM conversation_messages m JOIN sessions s ON s.id=m.session_id
      WHERE NOT EXISTS (SELECT 1 FROM events_v8 e WHERE e.session_id=m.session_id AND e.event_id=m.source_event_id)
      ORDER BY m.occurred_at,m.sequence`).all() as Array<Record<string, unknown>>;
    // History reads in id order, and these predate every retained event, so they take the
    // free ids just below the oldest one when there is room.
    const oldest = Number((db.prepare("SELECT MIN(id) AS id FROM events_v8").get() as { id: number | null }).id ?? highWater + 1);
    let nextId = oldest - lost.length >= 1 ? oldest - lost.length : null;
    const insert = db.prepare(`INSERT INTO events_v8(id,session_id,event_id,worker_run_id,type,turn_id,item_id,created_at,body)
      SELECT ?,?,?,NULL,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events_v8 WHERE session_id=? AND event_id=?)`);
    for (const row of lost) {
      const id = nextId === null ? null : nextId++;
      if (typeof row.content !== "string") continue;
      let type = "message.completed", payload: Record<string, unknown>;
      if (row.role === "tool") {
        const [head = "", ...rest] = row.content.split("\n");
        type = "command.completed";
        payload = { command: head.replace(/^\$ /, ""), output: rest.filter((line) => !/^\[status=/.test(line)).join("\n"),
          status: "unknown", restored: true };
      } else payload = { role: row.role === "user" ? "user" : "assistant", text: row.content, restored: true };
      insert.run(id, String(row.session_id), String(row.source_event_id), type, row.turn_id == null ? null : String(row.turn_id),
        row.item_id == null ? null : String(row.item_id),
        Number(row.occurred_at), encodeEventBody(type, payload), String(row.session_id), String(row.source_event_id));
    }
  }
  const bulky = db.prepare(`SELECT id FROM events_v8 WHERE type IN ('command.completed','file_change.completed')
    AND typeof(body)='text' AND length(body)>=1024`).all() as Array<{ id: number }>;
  const read = db.prepare("SELECT type,body FROM events_v8 WHERE id=?");
  const write = db.prepare("UPDATE events_v8 SET body=? WHERE id=?");
  for (const { id } of bulky) {
    const row = read.get(id) as { type: string; body: string };
    write.run(encodeEventBody(row.type, decodeEventBody(row.body)), id);
  }
  db.exec(`
    DROP TABLE events;
    ALTER TABLE events_v8 RENAME TO events;
    CREATE UNIQUE INDEX events_upstream_idx ON events(session_id, event_id);
    CREATE INDEX events_session_id_idx ON events(session_id, id);
    DROP TABLE IF EXISTS conversation_messages_fts;
    DROP TABLE IF EXISTS conversation_messages_fts_trigram;
    DROP TABLE IF EXISTS conversation_source_aliases;
    DROP TABLE IF EXISTS conversation_archive_chunks;
    DROP TABLE IF EXISTS conversation_summaries;
    DROP TABLE IF EXISTS conversation_cleanup_audit;
    DROP TABLE IF EXISTS conversation_messages;
    DROP TABLE IF EXISTS stream_events;
    CREATE VIRTUAL TABLE event_search USING fts5(text, tokenize='trigram', content='', contentless_delete=1);
    CREATE TABLE stream_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL, UNIQUE(kind, id)
    );
  `);
  // Ids are public cursors (`e:<id>`); never hand out an id a client has already seen.
  db.prepare(`INSERT INTO sqlite_sequence(name,seq) SELECT 'events',0
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='events')`).run();
  db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='events'").run(highWater);
  const indexable = db.prepare(`SELECT id,session_id,type,turn_id,body FROM events
    WHERE type IN ('message.completed','turn.completed','command.completed','file_change.completed') ORDER BY id`)
    .all() as Array<{ id: number; session_id: string; type: string; turn_id: string | null; body: unknown }>;
  for (const row of indexable) indexEvent(db, row, decodeEventBody(row.body));
}
