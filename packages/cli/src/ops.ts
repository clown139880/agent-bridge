import { isAbsolute } from "node:path";
import { win32 } from "node:path";
import { ApiError, type ControlClient, type Json } from "./client.js";

/**
 * Driving Agent Bridge sessions from another agent (Hermes, Claude, Codex): list,
 * read, create, send a turn, wait for it, answer approvals and questions. The CLI
 * and the MCP server are both thin shells over these operations.
 */

const TERMINAL = new Set(["turn.completed", "turn.failed", "turn.interrupted"]);
const TRANSCRIPT_TYPES = ["message.completed", "turn.completed", "turn.failed", "turn.interrupted",
  "approval.requested", "approval.resolved", "user_input.requested", "user_input.resolved", "error"];

export type WaitState = "completed" | "failed" | "interrupted" | "approval" | "user_input"
  | "idle" | "offline" | "error" | "deleted" | "timeout";

export interface WaitResult {
  state: WaitState;
  sessionId: string;
  turnId: string | null;
  /** The turn's last assistant message, for a finished turn. */
  summary?: string;
  error?: string;
  /** Pending requests that stopped the wait; answer them, then wait again. */
  approvals?: Json[];
  userInput?: Json[];
  /** Resume point: pass it back to wait to continue without missing anything. */
  cursor: string;
  session: Json;
}

export interface SessionFilter {
  active?: boolean; workerId?: string; machineId?: string; workspace?: string; q?: string; limit?: number;
}

export class BridgeOps {
  constructor(private readonly client: ControlClient) {}

  async workers(): Promise<Json[]> {
    return (await this.client.get("/workers")).workers as Json[];
  }

  async sessions(filter: SessionFilter = {}): Promise<Json[]> {
    const page = await this.client.get("/sessions", { active: filter.active, workerId: filter.workerId,
      machineId: filter.machineId, workspace: filter.workspace, q: filter.q, limit: filter.limit ?? 15,
      sort: "updatedAt", order: "desc" });
    return (page.data as Json[]).map(sessionBrief);
  }

  /** A session and its recent transcript, oldest first. */
  async session(sessionId: string, events = 20): Promise<{ session: Json; events: Json[]; approvals: Json[]; userInput: Json[] }> {
    const [session, page, approvals, userInput] = await Promise.all([
      this.client.get(`/sessions/${encodeURIComponent(sessionId)}`),
      this.client.get(`/sessions/${encodeURIComponent(sessionId)}/events`, { tail: true, limit: events, type: TRANSCRIPT_TYPES }),
      this.client.get("/approvals", { sessionId }),
      this.client.get("/user-input", { sessionId }),
    ]);
    return { session: sessionBrief(session), events: (page.data as Json[]).map(eventBrief),
      approvals: approvals.data as Json[], userInput: userInput.data as Json[] };
  }

  /**
   * Start a session on a worker (`claude@hal`, `codex@dev-wsl`, ...). `workspace` is an
   * absolute path or the name of one of the worker's recent workspaces.
   */
  async create(input: { workerId: string; workspace: string; input?: string; model?: string }): Promise<{ sessionId: string; turnId: string | null; workspace: string; cursor: string }> {
    const workspace = await this.resolveWorkspace(input.workerId, input.workspace);
    const cursor = await this.cursor();
    const receipt = await this.client.post("/sessions", { workerId: input.workerId, workspace,
      ...(input.input ? { input: input.input } : {}), ...(input.model ? { model: input.model } : {}) });
    const action = await this.client.settle(receipt);
    return { sessionId: action.sessionId, turnId: action.turnId ?? null, workspace, cursor };
  }

  /** Send a message: starts a turn when idle, steers the active turn otherwise. */
  async send(sessionId: string, input: string, options: { delivery?: "auto" | "steer" | "start_turn"; model?: string; reasoningEffort?: string } = {}):
    Promise<{ sessionId: string; turnId: string | null; delivery: string | null; cursor: string }> {
    const cursor = await this.cursor();
    const receipt = await this.client.post(`/sessions/${encodeURIComponent(sessionId)}/turns`, { input,
      delivery: options.delivery ?? "auto", ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) });
    const action = await this.client.settle(receipt);
    return { sessionId, turnId: action.turnId ?? null, delivery: action.resolvedAction ?? null, cursor };
  }

  async interrupt(sessionId: string): Promise<Json> {
    return this.client.settle(await this.client.post(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {}));
  }

  async approvals(filter: { sessionId?: string; machineId?: string } = {}): Promise<Json[]> {
    return (await this.client.get("/approvals", filter)).data as Json[];
  }

  async userInput(filter: { sessionId?: string; machineId?: string } = {}): Promise<Json[]> {
    return (await this.client.get("/user-input", filter)).data as Json[];
  }

  async decide(approvalId: string, choice: "allow" | "deny" | "allow-session"): Promise<Json> {
    return this.client.settle(await this.client.post(`/approvals/${encodeURIComponent(approvalId)}/decision`, { choice }));
  }

  /**
   * Answer a user-input request. `answers` maps question id to answers; a single
   * string answers a request that asks exactly one question.
   */
  async answer(requestId: string, answers: Record<string, string[]> | string): Promise<Json> {
    let body = answers;
    if (typeof body === "string") {
      const request = await this.client.get(`/user-input/${encodeURIComponent(requestId)}`);
      const questions = request.questions as Json[];
      if (questions.length !== 1) throw new ApiError(400, "answers_required",
        `the request asks ${questions.length} questions; answer each by id (${questions.map((q) => q.id).join(", ")})`);
      body = { [String(questions[0]!.id)]: [body] };
    }
    const payload = Object.fromEntries(Object.entries(body).map(([id, values]) => [id, { answers: values }]));
    return this.client.settle(await this.client.post(`/user-input/${encodeURIComponent(requestId)}/response`, { answers: payload }));
  }

  /**
   * Wait until the session needs someone: its turn finished (completed, failed,
   * interrupted), it asks for an approval or an answer, or it went offline.
   *
   * `turnId` names the turn to wait for (as returned by send/create); `cursor`
   * replays everything since that point, so a send followed by wait cannot miss a
   * turn that finished in between. Without either, the wait follows the turn
   * active now, and an idle session returns at once.
   */
  async wait(sessionId: string, options: { turnId?: string; cursor?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    let cursor = options.cursor ?? await this.cursor();
    let target = options.turnId;
    const session = await this.client.get(`/sessions/${encodeURIComponent(sessionId)}`);
    const result = (state: WaitState, extra: Partial<WaitResult> = {}, current: Json = session): WaitResult =>
      ({ state, sessionId, turnId: target ?? null, cursor, session: sessionBrief(current), ...extra });

    const pending = await this.pending(sessionId);
    if (pending) return result(pending.state, pending.extra);
    if (target) {
      const finished = await this.finishedTurn(sessionId, target);
      if (finished) return result(finished.state, finished.extra);
    } else if (!options.cursor) {
      if (typeof session.activeTurnId === "string") target = session.activeTurnId;
      else {
        const last = await this.finishedTurn(sessionId);
        return result(stopState(session.status) ?? "idle", last?.extra ?? {});
      }
    }
    const stop = stopState(session.status);
    if (stop && !options.cursor) return result(stop);

    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort);
    const timer = options.timeoutMs ? setTimeout(abort, options.timeoutMs) : undefined;
    try {
      for (;;) {
        try {
          for await (const envelope of this.client.stream({ cursor, sessionId, signal: controller.signal })) {
            cursor = envelope.cursor;
            const data = envelope.data;
            if (envelope.type === "session.event.appended" && TERMINAL.has(data.type)
              && (!target || data.turnId === target)) {
              target ??= data.turnId ?? undefined;
              return result(data.type.slice(5) as WaitState, terminalExtra(data));
            }
            if ((envelope.type === "approval.upserted" || envelope.type === "user_input.upserted") && data.status === "pending") {
              const now = await this.pending(sessionId);
              if (now) return result(now.state, now.extra);
            }
            if (envelope.type === "session.deleted") return result("deleted");
            if (envelope.type === "session.updated") {
              const state = stopState(data.status);
              if (state) return result(state, { error: data.error?.error?.message }, data);
            }
          }
        } catch (error) {
          if (controller.signal.aborted || (error instanceof ApiError && error.status < 500)) throw error;
          // The Control Plane restarted or the connection dropped: resume from the cursor.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted || options.signal?.aborted) throw error;
      return result("timeout", {}, await this.client.get(`/sessions/${encodeURIComponent(sessionId)}`));
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async cursor(): Promise<string> {
    return (await this.client.get("/approvals", { limit: 1 })).streamCursor as string;
  }

  private async pending(sessionId: string): Promise<{ state: WaitState; extra: Partial<WaitResult> } | undefined> {
    const approvals = await this.approvals({ sessionId });
    if (approvals.length) return { state: "approval", extra: { approvals } };
    const userInput = await this.userInput({ sessionId });
    if (userInput.length) return { state: "user_input", extra: { userInput } };
    return undefined;
  }

  /** The terminal event of `turnId`, or of the latest turn when omitted. */
  private async finishedTurn(sessionId: string, turnId?: string): Promise<{ state: WaitState; extra: Partial<WaitResult> } | undefined> {
    const page = await this.client.get(`/sessions/${encodeURIComponent(sessionId)}/events`,
      { tail: true, limit: 50, type: [...TERMINAL] });
    const event = (page.data as Json[]).reverse().find((item) => !turnId || item.turnId === turnId);
    return event ? { state: event.type.slice(5) as WaitState, extra: terminalExtra(event) } : undefined;
  }

  private async resolveWorkspace(workerId: string, workspace: string): Promise<string> {
    if (isAbsolute(workspace) || win32.isAbsolute(workspace)) return workspace;
    const worker = (await this.workers()).find((item) => item.id === workerId);
    if (!worker) throw new ApiError(404, "worker_not_found", `no worker ${workerId}`);
    const recent = (worker.recentWorkspaces ?? []) as Json[];
    const matches = recent.filter((item) => item.name === workspace);
    if (matches.length === 1) return matches[0]!.path;
    const known = recent.map((item) => item.name).join(", ") || "none";
    throw new ApiError(400, "workspace_unknown", matches.length
      ? `${workspace} names several workspaces on ${workerId}; pass the absolute path`
      : `${workspace} is not a recent workspace of ${workerId} (known: ${known}); pass the absolute path`);
  }
}

function stopState(status: unknown): WaitState | undefined {
  return status === "offline" ? "offline" : status === "error" ? "error" : undefined;
}

function terminalExtra(event: Json): Partial<WaitResult> {
  const payload = event.payload ?? {};
  return { turnId: event.turnId ?? null, ...(payload.summary ? { summary: payload.summary } : {}),
    ...(payload.error ? { error: payload.error } : {}) };
}

export function sessionBrief(session: Json): Json {
  return { sessionId: session.sessionId, workerId: session.workerId, status: session.status,
    title: session.title ?? session.promptSummary ?? null, workspace: session.workspace,
    activeTurnId: session.activeTurnId ?? null, lastTurnStatus: session.lastTurnStatus ?? null,
    pendingApprovals: session.pendingApprovalCount ?? 0, pendingUserInput: session.pendingUserInputCount ?? 0,
    updatedAt: session.updatedAt };
}

function eventBrief(event: Json): Json {
  const payload = event.payload ?? {};
  const text = payload.text ?? payload.summary ?? payload.error ?? payload.message ?? null;
  return { type: event.type, turnId: event.turnId ?? null, timestamp: event.timestamp,
    ...(payload.role ? { role: payload.role } : {}), ...(text !== null ? { text } : {}),
    ...(payload.choice ? { choice: payload.choice } : {}) };
}
