import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  workerId as buildWorkerId,
  type AgentType, type ActionKind, type ActionResultMessage, type ApprovalChoice, type SessionActivityStatus,
  type SessionState, type StructuredSessionEventMessage, type TurnStatus, type UserInputQuestion,
} from "@agent-bridge/protocol";

export interface RetentionOptions {
  sessionEventsMs: number;
  streamEventsMs: number;
  actionsMs: number;
  attachmentsMs: number;
}

export interface StoredAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface StreamRow {
  sequence: number;
  eventId: string;
  type: string;
  resourceKind: string;
  resourceId: string;
  sessionId: string | null;
  payload: unknown;
  createdAt: number;
}

export interface ActionRow {
  actionId: string;
  kind: ActionKind;
  status: "accepted" | "succeeded" | "failed";
  machineId: string;
  sessionId: string | null;
  turnId: string | null;
  resolvedAction?: "steer" | "start_turn";
  error: { code: string; message: string; retryable: boolean } | null;
  createdAt: number;
  updatedAt: number;
}

export interface PendingRow {
  id: string;
  kind: "approval" | "user_input";
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  machineId: string;
  agentType?: string;
  status: string;
  request: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  requestedAt: number;
  resolvedAt: number | null;
}

export interface SessionListQuery {
  statuses?: string[];
  machineId?: string;
  workerId?: string;
  agents?: string[];
  workspace?: string;
  taskId?: string;
  conversationId?: string;
  active?: boolean;
  updatedAfter?: number;
  dayStart?: number;
  segment?: "recent" | "history" | "all";
  q?: string;
  sort: "updatedAt" | "createdAt";
  order: "asc" | "desc";
  limit: number;
  cursor?: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; }
}

function promptExcerpt(value: string, limit = 80): string | null {
  const text=value.replace(/\s+/g," ").trim();
  if(!text)return null;
  const points=Array.from(text);
  return points.length<=limit?text:`${points.slice(0,limit).join("")}…`;
}

function encodeCursor(scope: string, values: unknown[]): string {
  return Buffer.from(JSON.stringify({ s: scope, v: values }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, scope: string): unknown[] {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown; v?: unknown };
    if (value.s !== scope || !Array.isArray(value.v)) throw new Error();
    return value.v;
  } catch { throw new Error("invalid_cursor"); }
}

function scopeFor(prefix: string, query: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 16)}`;
}

function legacyStatus(activity: SessionActivityStatus, lastTurn?: TurnStatus): string {
  if (activity === "active") return "working";
  if (activity === "waiting_for_input") return "waiting";
  if (activity === "waiting_for_approval") return "blocked";
  if (activity === "error") return "failed";
  if (activity === "idle" && lastTurn === "interrupted") return "stopped";
  if (activity === "idle" && lastTurn === "failed") return "failed";
  if (activity === "idle") return "completed";
  return "unknown";
}

export class AgentControlStore {
  constructor(readonly db: DatabaseSync, readonly retention: RetentionOptions) {}

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  private appendStream(type: string, kind: string, id: string, sessionId: string | null, payload: unknown): number {
    const now = Date.now();
    const eventId = randomUUID();
    const result = this.db.prepare(`INSERT INTO stream_events
      (event_id,type,resource_kind,resource_id,session_id,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(eventId, type, kind, id, sessionId, JSON.stringify(payload), now);
    return Number(result.lastInsertRowid);
  }

  streamCursor(): string { return `g:${this.maxStreamSequence()}`; }
  maxStreamSequence(): number {
    // MAX(table.sequence) falls back to zero after retention deletes every row,
    // which would move the advertised watermark backwards. sqlite_sequence is
    // the durable AUTOINCREMENT high-water mark and remains globally monotonic.
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='stream_events'").get() as
      { seq: number } | undefined;
    return Number(row?.seq ?? 0);
  }

  parseStreamCursor(cursor?: string): number {
    if (!cursor) return 0;
    const match = cursor.match(/^g:(\d+)$/);
    if (!match) throw new Error("invalid_cursor");
    return Number(match[1]);
  }

  streamAfter(after: number, limit = 200): StreamRow[] {
    const first = this.db.prepare("SELECT MIN(sequence) AS n FROM stream_events").get() as { n: number | null };
    const highWater = this.maxStreamSequence();
    if (after > highWater) throw new Error("invalid_cursor");
    if (after > 0 && ((first.n !== null && after < first.n - 1)
      || (first.n === null && after < highWater))) throw new Error("cursor_expired");
    const rows = this.db.prepare("SELECT * FROM stream_events WHERE sequence>? ORDER BY sequence LIMIT ?")
      .all(after, limit) as Record<string, unknown>[];
    return rows.map((row) => ({ sequence: Number(row.sequence), eventId: String(row.event_id),
      type: String(row.type), resourceKind: String(row.resource_kind), resourceId: String(row.resource_id),
      sessionId: row.session_id ? String(row.session_id) : null, payload: parseJson(row.payload, null),
      createdAt: Number(row.created_at) }));
  }

  updateMachineConnection(machineId: string, bridgeVersion: string | undefined, protocolVersion: number | undefined,
    features: string[] | undefined): void {
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare(`UPDATE machines SET bridge_version=?,protocol_version=?,features_json=?,connected_at=? WHERE id=?`)
        .run(bridgeVersion ?? null, protocolVersion ?? 1, JSON.stringify(features ?? []), now, machineId);
      const machine = this.db.prepare("SELECT * FROM machines WHERE id=?").get(machineId) as Record<string,unknown>;
      for (const { agentType, label } of this.machineAgents(parseJson<string[]>(machine.capabilities, []))) {
        const wire = this.workerWire(machine, agentType, label);
        this.appendStream("worker.upserted", "worker", String(wire.id), null, wire);
      }
    });
  }

  markMachineOffline(machineId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE machines SET status='offline' WHERE id=?").run(machineId);
      const machine = this.db.prepare("SELECT capabilities FROM machines WHERE id=?").get(machineId) as Record<string,unknown> | undefined;
      for (const { agentType } of this.machineAgents(machine ? parseJson<string[]>(machine.capabilities, []) : [])) {
        const wid = buildWorkerId(agentType, machineId);
        this.appendStream("worker.offline", "worker", wid, null, { workerId: wid, machineId, status: "offline" });
      }
      const sessions=this.db.prepare("SELECT id FROM sessions WHERE machine_id=?").all(machineId) as Array<{id:string}>;
      this.db.prepare("UPDATE sessions SET activity_status='offline' WHERE machine_id=?").run(machineId);
      for(const session of sessions)this.appendStream("session.updated","session",session.id,session.id,this.session(session.id));
    });
  }

  upsertSession(machineId: string, state: SessionState): void {
    if (this.isSessionDeleted(state.sessionId)) return;
    this.transaction(() => {
      const exists = this.db.prepare("SELECT id FROM sessions WHERE id=?").get(state.sessionId);
      if (exists) {
        this.db.prepare(`UPDATE sessions SET machine_id=?,agent_type=?,project_name=?,project_path=?,native_session_id=?,
          status=?,title=COALESCE(?,title),prompt_summary=COALESCE(?,prompt_summary),source=?,history_completeness=?,
          activity_status=?,active_turn_id=?,last_turn_status=COALESCE(?,last_turn_status),inventory_seen_at=?,
          updated_at=?,last_response_at=CASE WHEN last_response_at>? THEN ? ELSE last_response_at END WHERE id=?`).run(
          machineId, state.agentType, state.projectName, state.projectPath, state.nativeSessionId,
          legacyStatus(state.activityStatus, state.lastTurnStatus), state.title ?? null, state.promptSummary ?? null,
          state.source, state.historyCompleteness, state.activityStatus, state.activeTurnId ?? null,
          state.lastTurnStatus ?? null, Date.now(), state.updatedAt, state.updatedAt, state.updatedAt, state.sessionId);
      } else {
        this.db.prepare(`INSERT INTO sessions
          (id,machine_id,agent_type,project_name,project_path,matrix_room_id,matrix_thread_id,native_session_id,
           status,created_at,updated_at,title,prompt_summary,source,history_completeness,activity_status,active_turn_id,
           last_turn_status,inventory_seen_at) VALUES (?,?,?,?,?,'',NULL,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          state.sessionId, machineId, state.agentType, state.projectName, state.projectPath, state.nativeSessionId,
          legacyStatus(state.activityStatus, state.lastTurnStatus), state.createdAt, state.updatedAt,
          state.title ?? null, state.promptSummary ?? null, state.source, state.historyCompleteness,
          state.activityStatus, state.activeTurnId ?? null, state.lastTurnStatus ?? null, Date.now());
      }
      this.appendStream(exists ? "session.updated" : "session.upserted", "session", state.sessionId,
        state.sessionId, this.session(state.sessionId));
    });
  }

  updateSessionActivity(sessionId: string, activity: SessionActivityStatus, activeTurnId?: string,
    lastTurnStatus?: TurnStatus, error?: string): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE sessions SET activity_status=?,active_turn_id=?,last_turn_status=COALESCE(?,last_turn_status),
        last_error=?,status=? WHERE id=?`).run(activity, activeTurnId ?? null,
        lastTurnStatus ?? null, error ?? null, legacyStatus(activity, lastTurnStatus), sessionId);
      this.appendStream("session.updated", "session", sessionId, sessionId, this.session(sessionId));
    });
  }

  appendSessionEvent(machineId: string, message: StructuredSessionEventMessage): boolean {
    if (this.isSessionDeleted(message.sessionId)) return false;
    return this.transaction(() => {
      const run = this.db.prepare("SELECT id FROM worker_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1")
        .get(message.sessionId) as { id: string } | undefined;
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO events
        (session_id,event_id,worker_run_id,type,payload,created_at,turn_id,item_id,event_schema)
        VALUES (?,?,?,?,?,?,?,?,2)`).run(message.sessionId, message.eventId, run?.id ?? null, message.eventType,
          JSON.stringify({ cursor: "", eventId: message.eventId, type: message.eventType, sessionId: message.sessionId,
            runId: run?.id ?? null, turnId: message.turnId ?? null, itemId: message.itemId ?? null,
            timestamp: message.timestamp, payload: message.payload, machineId }), message.timestamp,
          message.turnId ?? null, message.itemId ?? null);
      if (!inserted.changes) return false;
      const sequence = Number(inserted.lastInsertRowid);
      const event = { cursor: `e:${sequence}`, eventId: message.eventId, type: message.eventType,
        sessionId: message.sessionId, runId: run?.id ?? null, turnId: message.turnId ?? null,
        itemId: message.itemId ?? null, timestamp: message.timestamp, payload: message.payload };
      this.db.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify(event), sequence);
      const payload = message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
        ? message.payload as Record<string, unknown> : {};
      const isReply = (message.eventType === "message.completed" && payload.role === "assistant")
        || (message.eventType === "turn.completed" && typeof payload.summary === "string" && payload.summary.trim().length > 0);
      if (isReply) this.db.prepare(`UPDATE sessions SET last_response_at=?,updated_at=?
        WHERE id=? AND (last_response_at IS NULL OR last_response_at<?)`)
        .run(message.timestamp, message.timestamp, message.sessionId, message.timestamp);
      this.appendStream("session.event.appended", "session", message.sessionId, message.sessionId, event);
      return true;
    });
  }

  upsertApproval(machineId: string, input: { approvalId: string; sessionId: string; turnId?: string;
    kind: string; summary: string; choices: ApprovalChoice[]; requestedAt?: number }): void {
    this.upsertPending(machineId, "approval", input.approvalId, input.sessionId, input.turnId, {
      approvalId: input.approvalId, kind: input.kind, summary: input.summary, choices: input.choices,
    }, input.requestedAt ?? Date.now());
  }

  upsertUserInput(machineId: string, input: { requestId: string; sessionId: string; turnId?: string;
    questions: UserInputQuestion[]; requestedAt: number }): void {
    this.upsertPending(machineId, "user_input", input.requestId, input.sessionId, input.turnId,
      { requestId: input.requestId, questions: input.questions }, input.requestedAt);
  }

  private upsertPending(machineId: string, kind: "approval" | "user_input", id: string, sessionId: string,
    turnId: string | undefined, request: unknown, requestedAt: number): void {
    this.transaction(() => {
      const run = this.db.prepare("SELECT id FROM worker_runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1")
        .get(sessionId) as { id: string } | undefined;
      this.db.prepare(`INSERT INTO pending_requests
        (id,kind,session_id,worker_run_id,turn_id,machine_id,status,request_json,requested_at,upstream_request_id)
        VALUES (?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(id) DO UPDATE SET
        turn_id=excluded.turn_id,request_json=excluded.request_json,requested_at=excluded.requested_at`)
        .run(id, kind, sessionId, run?.id ?? null, turnId ?? null, machineId, JSON.stringify(request), requestedAt, id);
      const activity = kind === "approval" ? "waiting_for_approval" : "waiting_for_input";
      if(this.pending(id)?.status==="pending")this.db.prepare("UPDATE sessions SET activity_status=?,active_turn_id=COALESCE(?,active_turn_id) WHERE id=?")
        .run(activity, turnId ?? null, sessionId);
      this.appendStream(kind === "approval" ? "approval.upserted" : "user_input.upserted", kind, id,
        sessionId, this.pendingWire(this.pending(id)!));
    });
  }

  resolvePending(id: string, status: string, decision?: Record<string, unknown>): PendingRow | undefined {
    return this.transaction(() => {
      const current = this.pending(id);
      if (!current || current.status !== "pending") return current;
      const now = Date.now();
      this.db.prepare("UPDATE pending_requests SET status=?,decision_json=?,resolved_at=? WHERE id=?")
        .run(status, decision ? JSON.stringify(decision) : null, now, id);
      const type = current.kind === "approval" ? "approval.upserted" : "user_input.upserted";
      const resolved = this.pending(id)!;
      this.appendStream(type, current.kind, id, current.sessionId, this.pendingWire(resolved));
      this.refreshPendingActivity(current.sessionId, now);
      return resolved;
    });
  }

  pending(id: string): PendingRow | undefined {
    const row = this.db.prepare(`SELECT *, (SELECT agent_type FROM sessions WHERE sessions.id=pending_requests.session_id) AS agent_type
      FROM pending_requests WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPending(row) : undefined;
  }

  listPending(kind: "approval" | "user_input", input: { statuses: string[]; sessionId?: string; runId?: string;
    machineId?: string; limit: number; cursor?: string }): { data: PendingRow[]; nextCursor: string | null; hasMore: boolean } {
    const filter = { ...input, cursor: undefined, limit: undefined };
    const scope = scopeFor(kind, filter);
    const where = ["kind=?"], params: any[] = [kind];
    if (input.statuses.length) { where.push(`status IN (${input.statuses.map(() => "?").join(",")})`); params.push(...input.statuses); }
    if (input.sessionId) { where.push("session_id=?"); params.push(input.sessionId); }
    if (input.runId) { where.push("worker_run_id=?"); params.push(input.runId); }
    if (input.machineId) { where.push("machine_id=?"); params.push(input.machineId); }
    if (input.cursor) {
      const [time, id] = decodeCursor(input.cursor, scope);
      where.push("(requested_at<? OR (requested_at=? AND id<?))"); params.push(time, time, id);
    }
    const rows = this.db.prepare(`SELECT *, (SELECT agent_type FROM sessions WHERE sessions.id=pending_requests.session_id) AS agent_type
      FROM pending_requests WHERE ${where.join(" AND ")}
      ORDER BY requested_at DESC,id DESC LIMIT ?`).all(...params, input.limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > input.limit; if (hasMore) rows.pop();
    const data = rows.map((row) => this.mapPending(row)); const last = data.at(-1);
    return { data, hasMore, nextCursor: hasMore && last ? encodeCursor(scope, [last.requestedAt, last.id]) : null };
  }

  createAction(input: { principal: string; key: string; method: string; path: string; body: unknown;
    kind: ActionKind; machineId: string; sessionId?: string }): { action: ActionRow; existing: boolean } {
    const requestHash = createHash("sha256").update(JSON.stringify(input.body)).digest("hex");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM idempotency_keys WHERE principal=? AND key=?")
        .get(input.principal, input.key) as Record<string, unknown> | undefined;
      if (prior) {
        if (prior.method !== input.method || prior.path !== input.path || prior.request_hash !== requestHash)
          throw new Error("idempotency_key_reused");
        return { action: this.action(String(prior.action_id))!, existing: true };
      }
      const now = Date.now(), id = randomUUID(), expires = now + this.retention.actionsMs;
      this.db.prepare(`INSERT INTO actions
        (id,principal,kind,machine_id,session_id,status,result_json,created_at,updated_at,expires_at)
        VALUES (?,?,?,?,?,'accepted',?,?,?,?)`).run(id, input.principal, input.kind, input.machineId,
          input.sessionId ?? null, JSON.stringify({ request: input.body }), now, now, expires);
      this.db.prepare(`INSERT INTO idempotency_keys
        (principal,key,method,path,request_hash,action_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(input.principal, input.key, input.method, input.path, requestHash, id, now, expires);
      const action = this.action(id)!;
      this.appendStream("action.updated", "action", id, input.sessionId ?? null, this.actionWire(action));
      return { action, existing: false };
    });
  }

  findIdempotent(principal: string, key: string, method: string, path: string, body: unknown): ActionRow | undefined {
    const row=this.db.prepare("SELECT * FROM idempotency_keys WHERE principal=? AND key=?").get(principal,key) as Record<string,unknown>|undefined;
    if(!row)return undefined;
    const hash=createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if(row.method!==method||row.path!==path||row.request_hash!==hash)throw new Error("idempotency_key_reused");
    return this.action(String(row.action_id));
  }

  completeAction(message: ActionResultMessage): ActionRow | undefined {
    return this.transaction(() => {
      const current = this.action(message.actionId); if (!current || current.status !== "accepted") return current;
      const persisted = this.db.prepare("SELECT result_json FROM actions WHERE id=?").get(message.actionId) as { result_json: string | null };
      const request = parseJson<{request?:Record<string,unknown>}>(persisted.result_json, {}).request ?? {};
      this.db.prepare(`UPDATE actions SET status=?,session_id=COALESCE(?,session_id),turn_id=?,resolved_action=?,
        error_json=?,result_json=?,updated_at=? WHERE id=?`).run(message.status, message.sessionId ?? null,
          message.turnId ?? null, message.resolvedAction ?? null, message.error ? JSON.stringify(message.error) : null,
          JSON.stringify(message), message.timestamp, message.actionId);
      const action = this.action(message.actionId)!;
      this.appendStream("action.updated", "action", action.actionId, action.sessionId, this.actionWire(action));
      const pending = this.db.prepare("SELECT * FROM pending_requests WHERE resolving_action_id=?")
        .get(message.actionId) as Record<string,unknown>|undefined;
      if (pending) {
        if (message.status === "failed") {
          this.db.prepare("UPDATE pending_requests SET resolving_action_id=NULL WHERE id=?").run(String(pending.id));
        } else {
          const status = pending.kind === "approval" && request.choice === "deny" ? "denied" : "accepted";
          const decision = pending.kind === "approval" ? { choice: request.choice } : { answers: request.answers };
          this.db.prepare(`UPDATE pending_requests SET status=?,decision_json=?,resolved_at=?,resolving_action_id=NULL WHERE id=?`)
            .run(status, JSON.stringify(decision), message.timestamp, String(pending.id));
          this.appendStream(pending.kind === "approval" ? "approval.upserted" : "user_input.upserted",
            String(pending.kind), String(pending.id), String(pending.session_id), this.pendingWire(this.pending(String(pending.id))!));
          this.refreshPendingActivity(String(pending.session_id), message.timestamp);
        }
      }
      return action;
    });
  }

  action(id: string): ActionRow | undefined {
    const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { actionId: String(row.id), kind: row.kind as ActionKind, status: row.status as ActionRow["status"],
      machineId: String(row.machine_id), sessionId: row.session_id ? String(row.session_id) : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      resolvedAction: row.resolved_action as ActionRow["resolvedAction"],
      error: parseJson(row.error_json, null), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  pendingActions(machineId:string):Array<{action:ActionRow;request:Record<string,unknown>;path:string}>{
    const rows=this.db.prepare(`SELECT a.id,a.result_json,i.path FROM actions a
      JOIN idempotency_keys i ON i.action_id=a.id WHERE a.machine_id=? AND a.status='accepted' ORDER BY a.created_at`)
      .all(machineId) as Array<{id:string;result_json:string;path:string}>;
    return rows.map(row=>({action:this.action(row.id)!,request:parseJson<{request?:Record<string,unknown>}>(row.result_json,{}).request??{},path:row.path}));
  }

  reservePending(id: string, actionId: string): boolean {
    const result=this.db.prepare(`UPDATE pending_requests SET resolving_action_id=?
      WHERE id=? AND status='pending' AND (resolving_action_id IS NULL OR resolving_action_id=?)`).run(actionId,id,actionId);
    return result.changes > 0;
  }

  private refreshPendingActivity(sessionId: string, now: number): void {
    const kinds=this.db.prepare("SELECT kind FROM pending_requests WHERE session_id=? AND status='pending'")
      .all(sessionId) as Array<{kind:string}>;
    const activity=kinds.some(row=>row.kind==="user_input")?"waiting_for_input"
      :kinds.some(row=>row.kind==="approval")?"waiting_for_approval":"active";
    this.db.prepare("UPDATE sessions SET activity_status=?,status=? WHERE id=?")
      .run(activity,activity==="active"?"working":activity==="waiting_for_input"?"waiting":"blocked",sessionId);
    this.appendStream("session.updated","session",sessionId,sessionId,this.session(sessionId));
  }

  session(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSession(row, true) : undefined;
  }

  listSessions(input: SessionListQuery): { data: Record<string, unknown>[]; nextCursor: string | null; hasMore: boolean } {
    const filter = { ...input, cursor: undefined, limit: undefined };
    const scope = scopeFor("sessions", filter), column = input.sort === "createdAt" ? "created_at" : "updated_at";
    const direction = input.order === "asc" ? "ASC" : "DESC";
    const comparator = input.order === "asc" ? ">" : "<";
    const where: string[] = [], params: any[] = [];
    if (input.statuses?.length) { where.push(`activity_status IN (${input.statuses.map(() => "?").join(",")})`); params.push(...input.statuses); }
    const machine = input.machineId ?? (input.workerId?.includes("@") ? input.workerId.slice(input.workerId.indexOf("@") + 1) : undefined);
    if (machine) { where.push("machine_id=?"); params.push(machine); }
    if (input.agents?.length) { where.push(`agent_type IN (${input.agents.map(() => "?").join(",")})`); params.push(...input.agents); }
    if (input.workspace) { where.push("project_path=?"); params.push(input.workspace); }
    if (input.updatedAfter != null) { where.push("updated_at>?"); params.push(input.updatedAfter); }
    if (input.segment === "recent") {
      if (input.dayStart == null) throw new Error("day_start_required");
      where.push("(updated_at>=? OR activity_status IN ('creating','active','waiting_for_approval','waiting_for_input','error'))");
      params.push(input.dayStart);
    } else if (input.segment === "history") {
      if (input.dayStart == null) throw new Error("day_start_required");
      where.push("updated_at<? AND activity_status NOT IN ('creating','active','waiting_for_approval','waiting_for_input','error')");
      params.push(input.dayStart);
    }
    if (input.active != null) { where.push(input.active
      ? "activity_status IN ('active','waiting_for_approval','waiting_for_input')"
      : "activity_status NOT IN ('active','waiting_for_approval','waiting_for_input')"); }
    if (input.q) { where.push("(LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(prompt_summary,'')) LIKE ? OR LOWER(project_name) LIKE ?)"); const q=`%${input.q.toLowerCase()}%`; params.push(q,q,q); }
    if (input.taskId) { where.push("EXISTS(SELECT 1 FROM worker_runs r WHERE r.session_id=sessions.id AND r.task_id=?)"); params.push(input.taskId); }
    if (input.conversationId) { where.push("EXISTS(SELECT 1 FROM worker_runs r WHERE r.session_id=sessions.id AND r.conversation_id=?)"); params.push(input.conversationId); }
    if (input.cursor) { const [value,id] = decodeCursor(input.cursor, scope); where.push(`(${column}${comparator}? OR (${column}=? AND id${comparator}?))`); params.push(value,value,id); }
    const sql=`SELECT * FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${column} ${direction},id ${direction} LIMIT ?`;
    const rows=this.db.prepare(sql).all(...params,input.limit+1) as Record<string,unknown>[];
    const hasMore=rows.length>input.limit; if(hasMore) rows.pop();
    const data=rows.map(row=>this.mapSession(row,false)); const lastRow=rows.at(-1);
    return { data,hasMore,nextCursor:hasMore&&lastRow?encodeCursor(scope,[Number(lastRow[column]),String(lastRow.id)]):null };
  }

  sessionEvents(sessionId: string, after: string | undefined, limit: number, types: string[]):
    { data: unknown[]; nextCursor: string | null; hasMore: boolean } {
    let sequence=0;
    if(after){const match=after.match(/^e:(\d+)$/);if(!match)throw new Error("invalid_cursor");sequence=Number(match[1]);}
    const first=this.db.prepare("SELECT MIN(id) AS n FROM events WHERE session_id=? AND event_schema=2").get(sessionId) as {n:number|null};
    if(sequence>0&&first.n!==null&&sequence<first.n-1)throw new Error("cursor_expired");
    const where=["session_id=?","id>?","event_schema=2"],params:any[]=[sessionId,sequence];
    if(types.length){where.push(`type IN (${types.map(()=>"?").join(",")})`);params.push(...types);}
    const rows=this.db.prepare(`SELECT id,payload FROM events WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`)
      .all(...params,limit+1) as Array<{id:number;payload:string}>;
    const hasMore=rows.length>limit;if(hasMore)rows.pop();
    const data=rows.map(row=>parseJson(row.payload,{}));const last=rows.at(-1);
    return {data,hasMore,nextCursor:last?`e:${last.id}`:(after??null)};
  }

  isSessionDeleted(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM deleted_sessions WHERE session_id=?").get(id));
  }

  deleteSession(id: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT machine_id FROM sessions WHERE id=?").get(id) as { machine_id: string } | undefined;
      if (!row) return false;
      const now = Date.now();
      this.db.prepare(`INSERT INTO deleted_sessions(session_id,machine_id,deleted_at) VALUES(?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET machine_id=excluded.machine_id,deleted_at=excluded.deleted_at`)
        .run(id, row.machine_id, now);
      // Keep action receipts and idempotency keys until their normal retention
      // deadline so callers can observe the result of the delete action.
      this.db.prepare("DELETE FROM pending_requests WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM worker_runs WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM stream_events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.appendStream("session.deleted", "session", id, id, { sessionId: id, deletedAt: now });
      return true;
    });
  }

  resetTransientSessionActivity(): void {
    this.db.prepare("UPDATE sessions SET activity_status='offline' WHERE activity_status IN ('creating','active','waiting_for_approval','waiting_for_input')").run();
  }

  sessionEventsTail(sessionId: string, before: string | undefined, limit: number, types: string[]):
    { data: unknown[]; nextCursor: string | null; hasMore: boolean } {
    let sequence: number | undefined;
    if(before){const match=before.match(/^e:(\d+)$/);if(!match)throw new Error("invalid_cursor");sequence=Number(match[1]);}
    const where=["session_id=?","event_schema=2"],params:any[]=[sessionId];
    if(sequence!==undefined){where.push("id<?");params.push(sequence);}
    if(types.length){where.push(`type IN (${types.map(()=>"?").join(",")})`);params.push(...types);}
    const rows=this.db.prepare(`SELECT id,payload FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...params,limit+1) as Array<{id:number;payload:string}>;
    const hasMore=rows.length>limit;if(hasMore)rows.pop();
    rows.reverse();
    const data=rows.map(row=>parseJson(row.payload,{}));const first=rows.at(0);
    return {data,hasMore,nextCursor:hasMore&&first?`e:${first.id}`:null};
  }

  cleanup(now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM stream_events WHERE created_at<?").run(now-this.retention.streamEventsMs);
      this.db.prepare("DELETE FROM events WHERE event_schema=2 AND created_at<?").run(now-this.retention.sessionEventsMs);
      this.db.prepare("DELETE FROM idempotency_keys WHERE expires_at<?").run(now);
      this.db.prepare("DELETE FROM actions WHERE expires_at<?").run(now);
      this.db.prepare("DELETE FROM attachments WHERE created_at<?").run(now-this.retention.attachmentsMs);
    });
  }

  /** Store attachment bytes content-addressed by sha256; returns the ref (deduped). */
  putAttachment(bytes: Uint8Array, mimeType: string, filename: string): StoredAttachment {
    const id = createHash("sha256").update(bytes).digest("hex");
    this.db.prepare(`INSERT INTO attachments(id,mime_type,filename,size,bytes,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(id, mimeType, filename, bytes.length, bytes, Date.now());
    return { id, filename, mimeType, size: bytes.length };
  }

  getAttachment(id: string): (StoredAttachment & { bytes: Uint8Array }) | undefined {
    const row = this.db.prepare("SELECT id,mime_type,filename,size,bytes FROM attachments WHERE id=?").get(id) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: String(row.id), filename: String(row.filename), mimeType: String(row.mime_type),
      size: Number(row.size), bytes: row.bytes as Uint8Array };
  }

  private mapSession(row: Record<string, unknown>, detail: boolean): Record<string, unknown> {
    const latest = this.db.prepare("SELECT * FROM worker_runs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
      .get(String(row.id)) as Record<string, unknown> | undefined;
    const counts = this.db.prepare(`SELECT kind,COUNT(*) AS n FROM pending_requests WHERE session_id=? AND status='pending' GROUP BY kind`)
      .all(String(row.id)) as Array<{kind:string;n:number}>;
    const count=(kind:string)=>Number(counts.find(item=>item.kind===kind)?.n??0);
    const run=latest?{runId:String(latest.id),taskId:latest.task_id?String(latest.task_id):null,
      conversationId:latest.conversation_id?String(latest.conversation_id):null,status:String(latest.status),
      createdAt:Number(latest.created_at),updatedAt:Number(latest.updated_at)}:null;
    let promptSummary=row.prompt_summary?String(row.prompt_summary):null;
    if(!promptSummary){
      const messages=this.db.prepare("SELECT payload FROM events WHERE session_id=? AND event_schema=2 AND type='message.completed' ORDER BY id LIMIT 20")
        .all(String(row.id)) as Array<{payload:string}>;
      for(const message of messages){
        const event=parseJson<Record<string,unknown>>(message.payload,{});
        const payload=event.payload&&typeof event.payload==="object"&&!Array.isArray(event.payload)
          ?event.payload as Record<string,unknown>:undefined;
        if(payload?.role==="user"&&typeof payload.text==="string"){
          promptSummary=promptExcerpt(payload.text);
          if(promptSummary)break;
        }
      }
    }
    const result:Record<string,unknown>={sessionId:String(row.id),nativeSessionId:row.native_session_id?String(row.native_session_id):String(row.id),
      workerId:buildWorkerId(String(row.agent_type) as AgentType,String(row.machine_id)),machineId:String(row.machine_id),agent:String(row.agent_type),
      title:row.title?String(row.title):null,promptSummary,
      projectName:String(row.project_name),workspace:String(row.project_path),status:String(row.activity_status??"unknown"),
      activeTurnId:row.active_turn_id?String(row.active_turn_id):null,lastTurnStatus:row.last_turn_status?String(row.last_turn_status):null,
      pendingApprovalCount:count("approval"),pendingUserInputCount:count("user_input"),latestRun:run,
      createdAt:Number(row.created_at),updatedAt:Number(row.updated_at??row.created_at),
      lastResponseAt:row.last_response_at==null?null:Number(row.last_response_at),source:String(row.source??"app-server"),
      historyCompleteness:String(row.history_completeness??"loaded-only")};
    if(detail){const runs=this.db.prepare("SELECT * FROM worker_runs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 20")
      .all(String(row.id)) as Record<string,unknown>[];
      const contextRow=this.db.prepare("SELECT payload FROM events WHERE session_id=? AND event_schema=2 AND type='context.updated' ORDER BY id DESC LIMIT 1")
        .get(String(row.id)) as {payload:string}|undefined;
      const contextEvent=parseJson<Record<string,unknown>>(contextRow?.payload,{});
      const context=contextEvent.payload&&typeof contextEvent.payload==="object"&&!Array.isArray(contextEvent.payload)
        ? contextEvent.payload as Record<string,unknown>:undefined;
      Object.assign(result,{capabilities:[],runs:runs.map(r=>({runId:String(r.id),taskId:r.task_id?String(r.task_id):null,conversationId:r.conversation_id?String(r.conversation_id):null,status:String(r.status),createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)})),...(context?{context}:{}),matrixRoomId:row.matrix_room_id?String(row.matrix_room_id):null,matrixThreadId:row.matrix_thread_id?String(row.matrix_thread_id):null,error:row.last_error?{error:{code:"session_error",message:String(row.last_error),requestId:"",retryable:true}}:null});}
    return result;
  }

  private mapPending(row: Record<string, unknown>): PendingRow {
    return { id:String(row.id),kind:row.kind as PendingRow["kind"],sessionId:String(row.session_id),
      runId:row.worker_run_id?String(row.worker_run_id):null,turnId:row.turn_id?String(row.turn_id):null,
      machineId:String(row.machine_id),agentType:row.agent_type?String(row.agent_type):undefined,
      status:String(row.status),request:parseJson(row.request_json,{}),
      decision:parseJson(row.decision_json,null),requestedAt:Number(row.requested_at),
      resolvedAt:row.resolved_at==null?null:Number(row.resolved_at) };
  }

  private actionWire(action: ActionRow): Record<string,unknown> {
    return {actionId:action.actionId,kind:action.kind,status:action.status,sessionId:action.sessionId,
      turnId:action.turnId,resolvedAction:action.resolvedAction,
      error:action.error?{error:{...action.error,requestId:action.actionId}}:null,
      createdAt:action.createdAt,updatedAt:action.updatedAt};
  }

  private pendingWire(row: PendingRow): Record<string,unknown> {
    const common={sessionId:row.sessionId,runId:row.runId,turnId:row.turnId,
      workerId:buildWorkerId((row.agentType??"codex-cli") as AgentType,row.machineId),
      status:row.status,requestedAt:row.requestedAt,resolvedAt:row.resolvedAt};
    return row.kind==="approval"?{approvalId:row.id,...common,kind:row.request.kind,summary:row.request.summary,
      choices:row.request.choices,decision:row.decision?.choice??null}
      :{requestId:row.id,...common,questions:row.request.questions,answers:row.decision?.answers??null};
  }

  private workerWire(row:Record<string,unknown>,agentType:AgentType,label:string):Record<string,unknown>{
    const machineId=String(row.id),capabilities=parseJson<string[]>(row.capabilities,[]),features=parseJson<string[]>(row.features_json,[]);
    return{id:buildWorkerId(agentType,machineId),machineId,name:`${label} @ ${String(row.name)}`,status:String(row.status),
      platform:String(row.platform),hostname:String(row.hostname),capabilities:[...new Set([...capabilities,...features])],
      workspaces:[],recentWorkspaces:[],lastSeenAt:Number(row.last_seen_at),bridgeVersion:row.bridge_version?String(row.bridge_version):null,
      activeSessionCount:0};
  }

  /** The agent workers a machine hosts, mirroring the /workers listing: Codex is
   *  always present; Claude appears when the bridge advertises the capability. */
  private machineAgents(capabilities:string[]):Array<{agentType:AgentType;label:string}>{
    const agents:Array<{agentType:AgentType;label:string}>=[{agentType:"codex-cli",label:"Codex"}];
    if(capabilities.includes("claude-code"))agents.push({agentType:"claude-code",label:"Claude"});
    return agents;
  }
}
