import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AgentEvent, type AgentStatus, type AgentType } from "@agent-bridge/protocol";
import { decodeEventBody } from "./events.js";
import { migrateDatabase } from "./migrations.js";
import { markChanged } from "./stream.js";
export * from "./control.js";
export * from "./events.js";
export * from "./stream.js";
export * from "./memory.js";

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

export interface WorkerRunRecord {
  id: string;
  taskId: string | null;
  conversationId: string | null;
  machineId: string;
  agentType: AgentType;
  projectPath: string;
  sessionId: string | null;
  status: AgentStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredAgentEvent {
  sequence: number;
  event: AgentEvent;
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
    migrateDatabase(this.db);
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
    this.db.prepare("UPDATE sessions SET matrix_thread_id=? WHERE id=?").run(threadId, sessionId);
  }

  updateSessionStatus(sessionId: string, status: AgentStatus): void {
    this.db.prepare("UPDATE sessions SET status=? WHERE id=?").run(status, sessionId);
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
    this.db.prepare("UPDATE sessions SET native_session_id=? WHERE id=?")
      .run(nativeSessionId, sessionId);
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(mapSession);
  }

  listProjectPaths(machineId: string, limit = 8): string[] {
    const rows = this.db.prepare(`
      SELECT project_path FROM sessions
      WHERE machine_id=?
      GROUP BY project_path
      ORDER BY MAX(updated_at) DESC
      LIMIT ?
    `).all(machineId, limit) as Array<{ project_path: string }>;
    return rows.map((row) => String(row.project_path));
  }

  createWorkerRun(run: WorkerRunRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare(`
      INSERT INTO worker_runs
      (id, task_id, conversation_id, machine_id, agent_type, project_path, session_id,
       status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.taskId, run.conversationId, run.machineId, run.agentType, run.projectPath, run.sessionId,
      run.status, run.error, run.createdAt, run.updatedAt);
      markChanged(this.db, "run", run.id); this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  getWorkerRun(id: string): WorkerRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM worker_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapWorkerRun(row) : undefined;
  }

  getWorkerRunBySession(sessionId: string): WorkerRunRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM worker_runs WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapWorkerRun(row) : undefined;
  }

  getLatestWorkerRunByConversation(conversationId: string, machineId: string, projectPath: string): WorkerRunRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM worker_runs
      WHERE conversation_id=? AND machine_id=? AND project_path=? AND session_id IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(conversationId, machineId, projectPath) as Record<string, unknown> | undefined;
    return row ? mapWorkerRun(row) : undefined;
  }

  getLatestLegacyWorkerRunByTask(taskId: string, machineId: string, projectPath: string): WorkerRunRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM worker_runs
      WHERE task_id=? AND machine_id=? AND project_path=? AND session_id IS NOT NULL
        AND conversation_id IS NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(taskId, machineId, projectPath) as Record<string, unknown> | undefined;
    return row ? mapWorkerRun(row) : undefined;
  }

  attachWorkerRun(id: string, sessionId: string, status: AgentStatus): void {
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("UPDATE worker_runs SET session_id=?, status=?, updated_at=? WHERE id=?")
        .run(sessionId, status, Date.now(), id); markChanged(this.db, "run", id); this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  updateWorkerRun(id: string, status: AgentStatus, error?: string): void {
    this.db.exec("BEGIN IMMEDIATE"); try {
      this.db.prepare("UPDATE worker_runs SET status=?, error=?, updated_at=? WHERE id=?")
        .run(status, error ?? null, Date.now(), id); markChanged(this.db, "run", id); this.db.exec("COMMIT");
    } catch (caught) { try { this.db.exec("ROLLBACK"); } catch {} throw caught; }
  }

  /**
   * The legacy run event feed, projected from the run's stored session events.
   * `next` is the last scanned event id so a caller never rescans skipped rows.
   */
  listRunEvents(sessionId: string, workerRunId: string, after = 0, limit = 100): { events: StoredAgentEvent[]; next: number } {
    const rows = this.db.prepare(`SELECT id,event_id,type,created_at,body FROM events
      WHERE session_id=? AND worker_run_id=? AND id>? AND type IN
        ('message.completed','turn.started','turn.completed','turn.failed','turn.interrupted')
      ORDER BY id LIMIT ?`).all(sessionId, workerRunId, after, limit) as Array<Record<string, unknown>>;
    const events: StoredAgentEvent[] = [];
    for (const row of rows) {
      const payload = decodeEventBody(row.body), timestamp = Number(row.created_at), eventId = String(row.event_id);
      const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
      let event: AgentEvent | undefined;
      if (row.type === "message.completed") {
        if (payload.role === "assistant" && text(payload.text)) event = { type: "agent.output", eventId, sessionId, timestamp, text: text(payload.text) };
      } else if (row.type === "turn.started") event = { type: "agent.started", eventId, sessionId, timestamp };
      else if (row.type === "turn.completed") event = payload.status === "failed"
        ? { type: "agent.failed", eventId, sessionId, timestamp, summary: text(payload.error) ?? text(payload.summary) }
        : { type: "agent.completed", eventId, sessionId, timestamp, summary: text(payload.summary) };
      else if (row.type === "turn.failed") event = { type: "agent.failed", eventId, sessionId, timestamp,
        summary: text(payload.error) ?? text(payload.message) ?? text(payload.summary) };
      else event = { type: "agent.stopped", eventId, sessionId, timestamp, summary: text(payload.reason) };
      if (event) events.push({ sequence: Number(row.id), event });
    }
    return { events, next: rows.length ? Number(rows.at(-1)!.id) : after };
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

function mapWorkerRun(row: Record<string, unknown>): WorkerRunRecord {
  return {
    id: String(row.id), taskId: row.task_id ? String(row.task_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    machineId: String(row.machine_id), agentType: row.agent_type as AgentType,
    projectPath: String(row.project_path), sessionId: row.session_id ? String(row.session_id) : null,
    status: row.status as AgentStatus, error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
