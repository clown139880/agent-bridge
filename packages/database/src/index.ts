import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent, AgentStatus, AgentType } from "@agent-bridge/protocol";

export interface MachineRecord {
  id: string;
  name: string;
  platform: string;
  hostname: string;
  status: "online" | "offline";
  capabilities: string[];
  lastSeenAt: number;
}

export interface SessionRecord {
  id: string;
  machineId: string;
  agentType: AgentType;
  projectName: string;
  projectPath: string;
  matrixRoomId: string;
  matrixThreadId: string | null;
  nativeSessionId: string | null;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        hostname TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL REFERENCES machines(id),
        agent_type TEXT NOT NULL,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        matrix_room_id TEXT NOT NULL,
        matrix_thread_id TEXT,
        native_session_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_thread_idx
        ON sessions(matrix_room_id, matrix_thread_id);
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_native_idx
        ON sessions(machine_id, native_session_id)
        WHERE native_session_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const eventColumns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === "event_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN event_id TEXT");
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_upstream_idx
        ON events(session_id, event_id)
        WHERE event_id IS NOT NULL;
    `);
  }

  upsertMachine(machine: Omit<MachineRecord, "status" | "lastSeenAt">): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO machines (id, name, platform, hostname, status, capabilities, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, 'online', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, platform=excluded.platform, hostname=excluded.hostname,
        status='online', capabilities=excluded.capabilities, last_seen_at=excluded.last_seen_at
    `).run(machine.id, machine.name, machine.platform, machine.hostname, JSON.stringify(machine.capabilities), now, now);
  }

  touchMachine(id: string): void {
    this.db.prepare("UPDATE machines SET status='online', last_seen_at=? WHERE id=?").run(Date.now(), id);
  }

  markStaleMachinesOffline(before: number): void {
    this.db.prepare("UPDATE machines SET status='offline' WHERE last_seen_at < ?").run(before);
  }

  listMachines(): MachineRecord[] {
    const rows = this.db.prepare("SELECT * FROM machines ORDER BY name").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), platform: String(row.platform), hostname: String(row.hostname),
      status: row.status as "online" | "offline", capabilities: JSON.parse(String(row.capabilities)) as string[],
      lastSeenAt: Number(row.last_seen_at),
    }));
  }

  createSession(session: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions
      (id, machine_id, agent_type, project_name, project_path, matrix_room_id, matrix_thread_id,
       native_session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.machineId, session.agentType, session.projectName, session.projectPath,
      session.matrixRoomId, session.matrixThreadId, session.nativeSessionId, session.status,
      session.createdAt, session.updatedAt);
  }

  setThread(sessionId: string, threadId: string): void {
    this.db.prepare("UPDATE sessions SET matrix_thread_id=?, updated_at=? WHERE id=?").run(threadId, Date.now(), sessionId);
  }

  updateSessionStatus(sessionId: string, status: AgentStatus): void {
    this.db.prepare("UPDATE sessions SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), sessionId);
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }

  getSessionByThread(roomId: string, threadId: string): SessionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE matrix_room_id=? AND matrix_thread_id=? LIMIT 1",
    ).get(roomId, threadId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }

  getSessionByNative(machineId: string, nativeSessionId: string): SessionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE machine_id=? AND native_session_id=? LIMIT 1",
    ).get(machineId, nativeSessionId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }

  setNativeSessionId(sessionId: string, nativeSessionId: string): void {
    this.db.prepare("UPDATE sessions SET native_session_id=?, updated_at=? WHERE id=?")
      .run(nativeSessionId, Date.now(), sessionId);
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  addEvent(event: AgentEvent): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO events (session_id, event_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(event.sessionId, event.eventId ?? null, event.type, JSON.stringify(event), event.timestamp);
    return result.changes > 0;
  }
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id), machineId: String(row.machine_id), agentType: row.agent_type as AgentType,
    projectName: String(row.project_name), projectPath: String(row.project_path),
    matrixRoomId: String(row.matrix_room_id), matrixThreadId: row.matrix_thread_id ? String(row.matrix_thread_id) : null,
    nativeSessionId: row.native_session_id ? String(row.native_session_id) : null,
    status: row.status as AgentStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
