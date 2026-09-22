import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { basename } from "node:path";
import pino from "pino";
import type {
  ApprovalChoice,
  AttachmentRef,
  SessionState,
  StructuredSessionEventType,
} from "@agent-bridge/protocol";
import type { AgentAdapter, AdapterEmit } from "../agent-adapter.js";
import type { AttachmentFetcher } from "../attachments.js";
import { resolveProjectPath, summarizePrompt } from "../app-server.js";
import { deriveProjectIdentity } from "../path-utils.js";

const log = pino({ name: "pi-adapter" });
const LOG_LIMIT = 2_000;
const INIT_TIMEOUT_MS = 60_000;

interface PiModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

interface PiSession {
  sessionId: string;        // stable bridge-assigned public id
  nativeSessionId?: string; // pi uuid (from get_state), used for resume
  sessionFile?: string;     // pi session .jsonl path, used for resume
  requestId?: string;
  model?: string;           // current model id (bare, without provider prefix)
  cwd: string;
  projectPath: string;
  projectIdentity?: string;
  title?: string;
  promptSummary?: string;
  createdAt: number;
  updatedAt: number;
  discovered: boolean;
  proc: ChildProcessWithoutNullStreams;
  activeTurnId?: string;
  turnSeq: number;
  pendingTurnStart: boolean;
  lastTurnStatus?: "completed" | "failed" | "interrupted";
  logs: string[];
  assistantBuffer: string[];
  resolveInit?: () => void;
  ended: boolean;
}

/**
 * Drives the Pi coding agent via `pi --mode rpc` (JSON-line RPC over stdio),
 * one subprocess per bridge session. Translates Pi's JSONL events into the
 * bridge's normalized `BridgeToControlMessage` stream so downstream consumers
 * (control-plane, DB, DSH, Matrix) are agent-agnostic. Pi always auto-approves
 * tool calls (no permission prompt), so this adapter never emits approval
 * requests and expose `approve`/`respondUserInput` as no-ops.
 */
export class PiAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, PiSession>();
  private ready = false;
  /** Cached pi catalog (shared across sessions; one provider config per adapter). */
  private availableModels: PiModelInfo[] = [];
  private modelsFetched = false;

  constructor(
    private readonly options: {
      command: string;
      provider?: string;
      model?: string;
      sessionDir?: string;
      allowedRoots: string[];
      fetchAttachment?: AttachmentFetcher;
    },
    private readonly emit: AdapterEmit,
  ) {}

  async start(): Promise<void> {
    // Validate the pi binary is reachable so a misconfigured bridge fails fast
    // instead of registering and erroring on every session.
    this.ready = true;
  }

  stop(): void {
    this.ready = false;
    for (const session of this.sessions.values()) {
      session.ended = true;
      this.kill(session);
    }
    this.sessions.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  // ---- session lifecycle -------------------------------------------------

  async startSession(requestId: string, projectPath: string, prompt?: string, resumeSessionId?: string, model?: string, _attachments?: AttachmentRef[]): Promise<string> {
    const publicSessionId = resumeSessionId ?? `pi-${randomUUID()}`;
    await this.launch({ publicSessionId, requestId, projectPath, prompt, resumeNativeId: resumeSessionId, model });
    return publicSessionId;
  }

  async resumeSession(sessionId: string, projectPath: string, nativeSessionId?: string, model?: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    await this.launch({ publicSessionId: sessionId, requestId: sessionId, projectPath, resumeNativeId: nativeSessionId, model });
  }

  private async launch(params: { publicSessionId: string; requestId: string; projectPath: string; prompt?: string; resumeNativeId?: string; model?: string }): Promise<string> {
    const { publicSessionId: sessionId, requestId, projectPath, prompt, resumeNativeId, model } = params;
    const cwd = await resolveProjectPath(projectPath, this.options.allowedRoots);

    const args = ["--mode", "rpc"];
    if (this.options.provider) { args.push("--provider", this.options.provider); }
    // The bridge may omit a model; default to the adapter-configured model so a
    // first turn doesn't silently fall back to Pi's google default.
    const effectiveModel = model ?? this.options.model;
    if (effectiveModel) { args.push("--model", effectiveModel); }
    if (this.options.sessionDir) { args.push("--session-dir", this.options.sessionDir); }
    if (prompt) {
      const title = summarizePrompt(prompt, 60);
      if (title) args.push("--name", title);
    }

    const proc = spawn(this.options.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const session: PiSession = {
      sessionId,
      nativeSessionId: resumeNativeId,
      requestId,
      model: bareModelId(effectiveModel),
      cwd,
      projectPath: cwd,
      projectIdentity: await deriveProjectIdentity(cwd),
      promptSummary: summarizePrompt(prompt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      discovered: false,
      proc,
      turnSeq: 0,
      pendingTurnStart: false,
      logs: [],
      assistantBuffer: [],
      ended: false,
    };
    this.sessions.set(sessionId, session);

    let resolveInit!: () => void;
    let rejectInit!: (error: Error) => void;
    const initPromise = new Promise<void>((resolve, reject) => { resolveInit = resolve; rejectInit = reject; });
    session.resolveInit = resolveInit;
    const initTimer = setTimeout(() => {
      session.resolveInit = undefined;
      rejectInit(new Error(`Timed out waiting for pi session init: ${sessionId}`));
    }, INIT_TIMEOUT_MS);
    this.attachStreams(session);

    // Ask pi for its state so we capture the pi-controlled session id/file, which
    // lets us resume across a bridge restart. Do this immediately; it also proves
    // the RPC channel is live before the first turn.
    this.sendCommand(session, { type: "get_state" });
    await initPromise;
    clearTimeout(initTimer);
    session.resolveInit = undefined;

    if (prompt) {
      this.beginTurn(session, prompt);
      this.emitSessionEvent(session, "message.completed", `pi:${sessionId}:first:user`, { role: "user", text: summarizePrompt(prompt, 4000) ?? "" });
    }
    return sessionId;
  }

  private attachStreams(session: PiSession): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    session.proc.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      // JSONL framing: split on \n only. Pi explicitly warns not to use Node
      // readline here because it also splits on U+2028/U+2029 inside JSON strings.
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line) this.handleLine(session, line);
        newline = buffer.indexOf("\n");
      }
    });
    session.proc.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(session, buffer);
      this.onProcEnd(session);
    });
    session.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.trim()) this.appendLog(session, text.trim());
    });
    session.proc.on("error", (error) => {
      if (!session.ended) log.error({ error, sessionId: session.sessionId }, "pi process error");
      this.onProcEnd(session);
    });
    session.proc.on("close", () => this.onProcEnd(session));
  }

  private handleLine(session: PiSession, line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      log.warn({ error, line: line.slice(0, 120), sessionId: session.sessionId }, "pi emitted a non-JSON line");
      return;
    }
    const type = event.type as string;
    session.updatedAt = Date.now();
    switch (type) {
      case "response":
        this.handleResponse(session, event);
        break;
      case "turn_start":
        this.ensureTurnStarted(session);
        break;
      case "message_end":
        this.handleMessageEnd(session, event);
        break;
      case "turn_end":
        this.handleTurnEnd(session, event);
        break;
      case "agent_settled":
        this.handleSettled(session);
        break;
      case "agent_end":
        // A low-level run completed; may be followed by retry/compaction. Activity
        // is only truly settled on agent_settled, so do nothing here.
        break;
      case "tool_execution_end":
        this.handleToolEnd(session, event);
        break;
      case "extension_ui_request":
        // Pi extensions may dialogs; we have no operator surface, so surface via log.
        this.appendLog(session, `[pi-ui] ${String(event.method ?? "")} ${String(event.title ?? "")}`);
        break;
      default:
        break;
    }
  }

  private handleResponse(session: PiSession, event: Record<string, unknown>): void {
    const command = event.command as string | undefined;
    const success = event.success as boolean | undefined;
    if (command === "get_state" && success) {
      const data = (event.data as Record<string, unknown>) ?? {};
      const sessionId = data.sessionId as string | undefined;
      const sessionFile = data.sessionFile as string | undefined;
      const modelData = data.model as { id?: string } | undefined;
      if (sessionId) session.nativeSessionId = sessionId;
      if (sessionFile) session.sessionFile = sessionFile;
      if (modelData?.id) session.model = modelData.id;
      this.emitDiscovered(session);
      if (session.pendingTurnStart && !session.activeTurnId) {
        session.pendingTurnStart = false;
        this.startTurnEvents(session);
      }
      session.resolveInit?.();
      session.resolveInit = undefined;
      return;
    }
    if (command === "set_model") {
      if (success) {
        const modelData = (event.data as { id?: string } | undefined);
        if (modelData?.id) session.model = modelData.id;
        this.appendLog(session, `Model switched to ${session.model ?? "?"}`);
      } else {
        this.appendLog(session, `pi set_model failed: ${event.error ?? ""}`);
      }
      return;
    }
    if (command === "prompt" || command === "steer" || command === "follow_up") {
      if (!success) {
        this.appendLog(session, `pi ${command} failed: ${event.error ?? ""}`);
        if (session.activeTurnId) this.finishTurn(session, "failed", String(event.error ?? "pi command failed"));
      }
      if (session.pendingTurnStart && !session.activeTurnId) {
        session.pendingTurnStart = false;
        this.startTurnEvents(session);
      }
      return;
    }
  }

  private handleMessageEnd(session: PiSession, event: Record<string, unknown>): void {
    const message = (event.message as Record<string, unknown>) ?? {};
    const role = message.role as string | undefined;
    if (role !== "assistant") return;
    const content = message.content;
    const text = extractText(content);
    if (!text) return;
    this.appendLog(session, text);
    session.assistantBuffer.push(text);
    this.emit({ type: "agent.output", sessionId: session.sessionId, timestamp: Date.now(), text });
    this.emitSessionEvent(session, "message.completed", `pi:${session.sessionId}:${session.turnSeq}:assistant`, {
      role: "assistant",
      text: truncate(text),
    });
  }

  private handleTurnEnd(session: PiSession, event: Record<string, unknown>): void {
    this.emitSessionEvent(session, "turn.completed", `pi:${session.sessionId}:${session.turnSeq}:turn-end`, { status: "completed" });
  }

  private handleSettled(session: PiSession): void {
    if (session.activeTurnId) {
      const text = session.assistantBuffer.join("");
      this.finishTurn(session, "completed", text ? truncate(text) : undefined);
    }
    session.assistantBuffer = [];
  }

  private handleToolEnd(session: PiSession, event: Record<string, unknown>): void {
    const toolName = (event.toolName as string | undefined) ?? "tool";
    const result = (event.result as Record<string, unknown>) ?? {};
    const resultContent = Array.isArray(result.content) ? extractContentText(result.content) : "";
    const summary = `${toolName}${resultContent ? ` ${truncate(resultContent, 160)}` : ""}`;
    this.appendLog(session, summary);
    this.emitSessionEvent(session, "command.completed", `pi:${session.sessionId}:${event.toolCallId ?? session.turnSeq}:tool`, {
      command: summary,
      status: event.isError ? "failed" : "completed",
    });
  }

  private ensureTurnStarted(session: PiSession): void {
    if (!session.activeTurnId) this.startTurnEvents(session);
  }

  private emitDiscovered(session: PiSession): void {
    if (session.discovered) return;
    session.discovered = true;
    this.emit({
      type: "session.discovered",
      requestId: session.requestId,
      sessionId: session.sessionId,
      nativeSessionId: session.nativeSessionId ?? session.sessionId,
      agentType: "pi" as const,
      projectPath: session.projectPath,
      projectName: basename(session.projectPath),
      title: session.title ?? session.promptSummary,
      promptSummary: session.promptSummary,
      status: session.activeTurnId ? ("working" as const) : ("waiting" as const),
      createdAt: session.createdAt,
      projectIdentity: session.projectIdentity,
    });
  }

  private sendCommand(session: PiSession, command: Record<string, unknown>): void {
    if (session.ended || !session.proc.stdin.writable) return;
    session.proc.stdin.write(JSON.stringify(command) + "\n");
  }

  // ---- turn management ---------------------------------------------------

  private beginTurn(session: PiSession, text: string, model?: string): void {
    if (session.activeTurnId) {
      // Active turn: steer instead of starting a parallel prompt. Model cannot
      // change mid-turn, matching the control-plane model_not_applicable guard.
      this.sendCommand(session, { type: "steer", message: text });
      return;
    }
    this.applyModel(session, model);
    if (!session.discovered) {
      // Session not yet announced (init may still be in flight). Queue so the
      // prompt still gets a turn id once get_state resolves.
      session.pendingTurnStart = true;
    }
    this.sendCommand(session, { type: "prompt", message: text });
  }

  /**
   * Switch the pi subprocess to a different model before a new turn when the
   * caller supplies one. pi exposes set_model over RPC; the bridge only sends a
   * model on a fresh (idle) turn, so this is safe. Returns early when the model
   * is unchanged, unknown, or a turn is active.
   */
  private applyModel(session: PiSession, model?: string): void {
    if (!model) return;
    const wantId = bareModelId(model);
    if (!wantId || wantId === session.model) return;
    if (session.activeTurnId) return; // cannot switch mid-turn
    let provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : this.options.provider;
    if (!provider) {
      provider = this.availableModels.find((m) => m.id === wantId)?.provider;
    }
    if (!provider) {
      this.appendLog(session, `Cannot switch model to ${wantId}: provider unknown`);
      return;
    }
    this.sendCommand(session, { type: "set_model", provider, modelId: wantId });
    session.model = wantId; // optimistic; corrected by the set_model response
    this.appendLog(session, `Switching model to ${wantId}`);
  }

  private startTurnEvents(session: PiSession): string {
    const turnId = `${session.sessionId}:t${++session.turnSeq}:${randomUUID()}`;
    session.activeTurnId = turnId;
    session.pendingTurnStart = false;
    this.appendLog(session, "Turn started");
    this.emit({ type: "agent.started", sessionId: session.sessionId, timestamp: Date.now(), summary: "New turn started" });
    this.emitSessionEvent(session, "turn.started", `pi:${session.sessionId}:${turnId}:started`, { status: "in_progress" }, turnId);
    return turnId;
  }

  private finishTurn(session: PiSession, status: "completed" | "failed" | "interrupted", summary?: string): void {
    const turnId = session.activeTurnId;
    session.activeTurnId = undefined;
    session.lastTurnStatus = status;
    if (!turnId) return;
    const eventId = `pi:${session.sessionId}:${turnId}:terminal`;
    if (status === "failed") {
      this.emit({ type: "agent.failed", sessionId: session.sessionId, timestamp: Date.now(), summary });
      this.emitSessionEvent(session, "turn.failed", `${eventId}:structured`, { status, summary }, turnId);
    } else if (status === "interrupted") {
      this.emit({ type: "agent.stopped", sessionId: session.sessionId, timestamp: Date.now() });
      this.emitSessionEvent(session, "turn.interrupted", `${eventId}:structured`, { status }, turnId);
    } else {
      this.emit({ type: "agent.completed", sessionId: session.sessionId, timestamp: Date.now(), summary });
      this.emitSessionEvent(session, "turn.completed", `${eventId}:structured`, { status, summary }, turnId);
    }
  }

  private onProcEnd(session: PiSession): void {
    if (session.ended) return;
    if (session.activeTurnId) {
      const text = session.assistantBuffer.join("");
      this.finishTurn(session, "failed", text ? truncate(text) : "pi process exited before the turn settled");
    }
  }

  private kill(session: PiSession): void {
    session.ended = true;
    try {
      session.proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      session.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }

  // ---- AgentAdapter surface ----------------------------------------------

  async input(sessionId: string, text: string, model?: string, _attachments?: AttachmentRef[]): Promise<void> {
    this.beginTurn(this.require(sessionId), text, model);
  }

  async createSessionAction(actionId: string, projectPath: string, input?: string, model?: string, _attachments?: AttachmentRef[]): Promise<{ sessionId: string; turnId?: string }> {
    const sessionId = await this.startSession(actionId, projectPath, input, undefined, model);
    return { sessionId, turnId: this.sessions.get(sessionId)?.activeTurnId };
  }

  async submitTurnAction(
    actionId: string,
    sessionId: string,
    text: string,
    delivery: "auto" | "steer" | "start_turn",
    expectedTurnId?: string,
    model?: string,
    _reasoningEffort?: string,
    _attachments?: AttachmentRef[],
  ): Promise<{ sessionId: string; turnId?: string; resolvedAction: "steer" | "start_turn" }> {
    const session = this.require(sessionId);
    const activeTurnId = session.activeTurnId;
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    if (delivery === "steer" && !activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (delivery === "start_turn" && activeTurnId) throw domainError("turn_already_active", "session already has an active turn");
    // Switch the model before marking the turn active (start_turn); applyModel
    // refuses to change the model once a turn is active.
    if (model) this.applyModel(session, model);
    if (!activeTurnId) this.startTurnEvents(session);
    const resolvedAction = activeTurnId ? "steer" : "start_turn";
    this.sendCommand(session, { type: activeTurnId ? "steer" : "prompt", message: text });
    this.emitSessionEvent(session, "message.completed", `pi:${sessionId}:action:${actionId}:user`, { role: "user", text: truncate(text) });
    return { sessionId, turnId: session.activeTurnId, resolvedAction };
  }

  async interruptAction(sessionId: string, expectedTurnId?: string): Promise<{ sessionId: string; turnId: string }> {
    const session = this.require(sessionId);
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    this.sendCommand(session, { type: "abort" });
    this.finishTurn(session, "interrupted");
    return { sessionId, turnId: activeTurnId };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (!session.activeTurnId) throw new Error(`Session ${sessionId} has no active turn`);
    this.sendCommand(session, { type: "abort" });
    this.finishTurn(session, "interrupted");
  }

  async deleteSessionAction(sessionId: string): Promise<{ sessionId: string }> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.kill(session);
      this.sessions.delete(sessionId);
    }
    return { sessionId };
  }

  async approve(_sessionId: string, _approvalId: string, _choice: ApprovalChoice): Promise<void> {
    // Pi auto-approves tool calls; approvals are never emitted.
  }

  async respondUserInput(_sessionId: string, _publicId: string, _answers: Record<string, { answers: string[] }>): Promise<void> {
    // Pi's base RPC protocol has no pending user-input surface.
  }

  async models(): Promise<import('@agent-bridge/protocol').CodexModelInfo[]> {
    if (!this.modelsFetched) {
      this.availableModels = await this.queryAvailableModels();
      this.modelsFetched = true;
    }
    return this.availableModels.map((m) => ({
      id: `${m.provider}/${m.id}`,
      model: m.id,
      displayName: m.name ?? m.id,
      isDefault: m.id === bareModelId(this.options.model),
      defaultReasoningEffort: m.reasoning ? "medium" : undefined,
      supportedReasoningEfforts: m.reasoning
        ? [{ reasoningEffort: "off", description: "No extended thinking" }, { reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }]
        : undefined,
    }));
  }

  /**
   * Query pi's available model catalog via a short-lived RPC subprocess. The
   * catalog is provider-config-scoped, so it is cached once per adapter and
   * shared across sessions (a throwaway process avoids needing a live session).
   */
  private queryAvailableModels(): Promise<PiModelInfo[]> {
    return new Promise((resolve) => {
      const args = ["--mode", "rpc"];
      if (this.options.provider) { args.push("--provider", this.options.provider); }
      if (this.options.model) { args.push("--model", this.options.model); }
      if (this.options.sessionDir) { args.push("--session-dir", this.options.sessionDir); }
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let settled = false;
      let proc: ChildProcessWithoutNullStreams;
      const finish = (models: PiModelInfo[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.stdin.end(); } catch { /* already closed */ }
        try { proc.kill("SIGTERM"); } catch { /* already dead */ }
        resolve(models);
      };
      const timer = setTimeout(() => finish([]), 15_000);
      try {
        proc = spawn(this.options.command, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env: process.env });
      } catch {
        clearTimeout(timer);
        resolve([]);
        return;
      }
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line) {
            try {
              const event = JSON.parse(line) as { type?: string; command?: string; success?: boolean; data?: { models?: Array<{ provider?: string; id?: string; name?: string; reasoning?: boolean }> } };
              if (event.type === "response" && event.command === "get_available_models" && event.success) {
                finish((event.data?.models ?? []).map((m) => ({
                  provider: m.provider ?? "",
                  id: m.id ?? "",
                  name: m.name,
                  reasoning: m.reasoning,
                })).filter((m) => m.id));
              }
            } catch { /* ignore malformed lines */ }
          }
          newline = buffer.indexOf("\n");
        }
      });
      proc.stderr.on("data", () => { /* ignored */ });
      proc.on("error", () => finish([]));
      proc.on("close", () => finish([]));
      proc.stdin.write(JSON.stringify({ type: "get_available_models" }) + "\n");
    });
  }

  async reconcileActivity(): Promise<void> {
    /* no long-lived server to reconcile; activity is tracked live from the stream. */
  }

  stateSnapshot(): { sessions: SessionState[]; approvals: Array<Record<string, unknown>>; userInputs: Array<Record<string, unknown>> } {
    const sessions: SessionState[] = [...this.sessions.values()]
      .filter((s) => s.discovered)
      .map((s) => ({
        sessionId: s.sessionId,
        nativeSessionId: s.nativeSessionId ?? s.sessionId,
        agentType: "pi" as const,
        projectPath: s.projectPath,
        projectName: basename(s.projectPath),
        title: s.title ?? s.promptSummary,
        promptSummary: s.promptSummary,
        activityStatus: s.activeTurnId ? ("active" as const) : ("idle" as const),
        activeTurnId: s.activeTurnId,
        lastTurnStatus: s.lastTurnStatus,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: "pi-rpc" as const,
        historyCompleteness: "terminal-only" as const,
        projectIdentity: s.projectIdentity,
      }));
    return { sessions, approvals: [], userInputs: [] };
  }

  logs(sessionId: string, count: number): string {
    return this.sessions.get(sessionId)?.logs.slice(-count).join("\n") || "No structured events captured yet.";
  }

  hasActiveSessions(): boolean {
    for (const s of this.sessions.values()) {
      if (s.activeTurnId) return true;
    }
    return false;
  }

  sessionActivity(): { activeSessionIds: string[]; waitingSessionIds: string[]; blockedSessionIds: string[] } {
    const activeSessionIds: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.activeTurnId) activeSessionIds.push(s.sessionId);
    }
    return { activeSessionIds, waitingSessionIds: [], blockedSessionIds: [] };
  }

  // ---- helpers -----------------------------------------------------------

  private require(sessionId: string): PiSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown pi session: ${sessionId}`);
    return session;
  }

  private appendLog(session: PiSession, text: string): void {
    session.logs.push(...text.split("\n"));
    if (session.logs.length > LOG_LIMIT) session.logs.splice(0, session.logs.length - LOG_LIMIT);
  }

  private emitSessionEvent(session: PiSession, eventType: StructuredSessionEventType, eventId: string, payload: Record<string, unknown>, turnId = session.activeTurnId): void {
    this.emit({ type: "session.event", eventType, sessionId: session.sessionId, eventId, timestamp: Date.now(), turnId, payload });
  }
}

// ---- module helpers ------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block): string => {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && b.text) return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
      .map((block) => (block as { text?: string }).text ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncate(text: string, limit = 4_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function domainError(code: string, message: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable: false });
}

/** Strip a `provider/id` prefix, leaving the bare pi model id used by set_model. */
function bareModelId(model?: string): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}
