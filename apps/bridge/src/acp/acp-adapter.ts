import { waitForTurnSettlement } from "../turn-settlement.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename } from "node:path";
import pino from "pino";
import {
  DEFAULT_EFFORT,
  type ApprovalChoice,
  type ApprovalKind,
  type AttachmentRef,
  type CodexModelInfo,
  type ProgressPhase,
  type SessionState,
  type StructuredSessionEventType,
} from "@agent-bridge/protocol";
import type { AgentAdapter, AdapterEmit, ResumeTarget } from "../agent-adapter.js";
import type { AttachmentFetcher, FetchedAttachment } from "../attachments.js";
import { resolveProjectPath, summarizePrompt } from "../app-server.js";
import { deriveProjectIdentity } from "../path-utils.js";
import { AcpConnection, AcpRpcError } from "./connection.js";
import type { AcpAgentProfile } from "./profiles.js";

const log = pino({ name: "acp-adapter" });
const LOG_LIMIT = 2_000;
const INIT_TIMEOUT_MS = 60_000;
const MODEL_CACHE_MS = 5 * 60_000;
const ACP_PROTOCOL_VERSION = 1;

/** An ACP session config option (`configOptions` in session/new and config_option_update). */
interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string; description?: string }>;
}

/** The unstable ACP model state (`models` in session/new; Grok also sends it in initialize `_meta.modelState`). */
interface ModelState {
  currentModelId?: string;
  availableModels?: Array<{ modelId: string; name?: string;
    _meta?: { reasoningEfforts?: Array<{ value?: string; id?: string; label?: string; description?: string; default?: boolean }> } }>;
}

interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean };
  sessionCapabilities?: { resume?: unknown; close?: unknown };
}

interface ToolCall {
  title: string;
  /** The first title the agent gave the call, usually the tool's name. */
  name: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: unknown[];
  locations?: Array<{ path?: string }>;
  key: string;
}

interface PendingApproval {
  approvalId: string;
  kind: ApprovalKind;
  summary: string;
  choices: ApprovalChoice[];
  options: Array<{ optionId: string; kind: string }>;
  turnId?: string;
  requestedAt: number;
  resolve: (result: unknown) => void;
}

interface AcpSession {
  interrupting?: boolean;
  sessionId: string;
  nativeSessionId?: string;
  requestId?: string;
  cwd: string;
  projectIdentity?: string;
  title?: string;
  promptSummary?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  /** Set whenever the session has no active turn; drives idle reaping. */
  settledAt?: number;
  discovered: boolean;
  proc: ChildProcessWithoutNullStreams;
  conn: AcpConnection;
  capabilities: AgentCapabilities;
  config: ConfigOption[];
  models?: ModelState;
  /** session/load replays the conversation as updates; they are history, not new events. */
  replaying: boolean;
  activeTurnId?: string;
  turnSeq: number;
  lastTurnStatus?: "completed" | "failed" | "interrupted";
  /** Prompts sent while a turn ran; ACP cannot steer, so each becomes the next turn. */
  queued: Array<{ text: string; images: FetchedAttachment[] }>;
  logs: string[];
  /** Assistant text streaming in the active turn, flushed as one message at each tool call and at the end. */
  messageText: string;
  turnMessageSeq: number;
  lastAssistantText?: string;
  phase?: ProgressPhase;
  toolCalls: Map<string, ToolCall>;
  toolCallCount: number;
  approvals: Map<string, PendingApproval>;
  ended: boolean;
}

/**
 * Drives any Agent Client Protocol agent (Grok Build, and others through an
 * {@link AcpAgentProfile}) over stdio, one subprocess per Bridge session.
 * Translates ACP `session/update` notifications into the Bridge's normalized
 * message stream and `session/request_permission` into approvals.
 */
export class AcpAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, AcpSession>();
  /** How long an interrupted turn may take to settle before its process is killed. */
  private settleTimeoutMs = 10_000;
  private ready = false;
  private modelCache?: { at: number; models: CodexModelInfo[] };
  private modelQuery?: Promise<CodexModelInfo[]>;

  constructor(
    private readonly options: {
      profile: AcpAgentProfile;
      allowedRoots: string[];
      fetchAttachment?: AttachmentFetcher;
    },
    private readonly emit: AdapterEmit,
  ) {}

  private get profile(): AcpAgentProfile { return this.options.profile; }

  async start(): Promise<void> {
    this.ready = true;
  }

  stop(): void {
    this.ready = false;
    for (const session of this.sessions.values()) this.kill(session);
    this.sessions.clear();
  }

  isReady(): boolean {
    return this.ready;
  }

  // ---- session lifecycle -------------------------------------------------

  async startSession(requestId: string, projectPath: string, prompt?: string, resume?: ResumeTarget, model?: string, attachments?: AttachmentRef[], reasoningEffort?: string): Promise<string> {
    const images = await this.materialize(attachments);
    if (!resume) {
      const sessionId = `${this.profile.sessionPrefix}-${randomUUID()}`;
      await this.launch({ sessionId, requestId, projectPath, prompt, model, reasoningEffort, images });
      return sessionId;
    }
    const held = this.sessions.get(resume.sessionId);
    if (held?.activeTurnId) throw new Error(`${this.profile.label} session ${resume.sessionId} is busy`);
    const resumeNativeId = resume.nativeSessionId ?? held?.nativeSessionId;
    // A held, idle process still owns the conversation; replace it rather than run two.
    if (held) {
      this.kill(held);
      this.sessions.delete(held.sessionId);
    }
    await this.launch({ sessionId: resume.sessionId, requestId, projectPath, prompt, resumeNativeId, model, reasoningEffort, images });
    return resume.sessionId;
  }

  async resumeSession(sessionId: string, projectPath: string, nativeSessionId?: string, model?: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    await this.launch({ sessionId, requestId: sessionId, projectPath, resumeNativeId: nativeSessionId, model });
  }

  private async launch(params: { sessionId: string; requestId: string; projectPath: string; prompt?: string;
    resumeNativeId?: string; model?: string; reasoningEffort?: string; images?: FetchedAttachment[] }): Promise<void> {
    const { sessionId, requestId, projectPath, prompt, resumeNativeId, model, reasoningEffort, images } = params;
    const cwd = await resolveProjectPath(projectPath, this.options.allowedRoots);
    const session = this.spawnSession(sessionId, cwd);
    session.requestId = requestId;
    session.projectIdentity = await deriveProjectIdentity(cwd);
    session.promptSummary = summarizePrompt(prompt);
    this.sessions.set(sessionId, session);

    try {
      await withTimeout(this.open(session, resumeNativeId), INIT_TIMEOUT_MS,
        `Timed out waiting for ${this.profile.label} session init: ${sessionId}`);
    } catch (error) {
      const output = session.logs.slice(-5).join("\n").trim();
      log.error({ sessionId, resumeNativeId, error: errorText(error) }, "ACP session failed to initialize");
      this.kill(session);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      throw new Error(`${this.profile.label} failed to start: ${errorText(error)}${output ? `\n${output}` : ""}`);
    }
    this.emitDiscovered(session);
    await this.applyConfig(session, model, reasoningEffort);
    if (prompt) {
      this.emitSessionEvent(session, "message.completed", `${this.eventPrefix(session)}:first:user`, { role: "user", text: summarizePrompt(prompt, 4000) ?? "" }, undefined);
      this.startPrompt(session, prompt, images ?? []);
    }
  }

  private spawnSession(sessionId: string, cwd: string): AcpSession {
    // AGENT_BRIDGE_SESSION_ID lets a tool the agent runs name its own Bridge session (deploy/hal/deploy.sh).
    // A systemd unit without User= sets no HOME, and agents keep their login under it (~/.grok).
    const proc = spawn(this.profile.command, this.profile.args(cwd), { cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME || homedir(), AGENT_BRIDGE_SESSION_ID: sessionId } });
    const session = {
      sessionId, cwd, proc, createdAt: Date.now(), updatedAt: Date.now(), settledAt: Date.now(), discovered: false,
      capabilities: {}, config: [], replaying: false, turnSeq: 0, queued: [], logs: [], messageText: "",
      turnMessageSeq: 0, toolCalls: new Map(), toolCallCount: 0, approvals: new Map(), ended: false,
    } as unknown as AcpSession;
    session.conn = new AcpConnection(proc.stdout, proc.stdin, {
      notification: (method, params) => this.handleNotification(session, method, params),
      request: (method, params) => this.handleRequest(session, method, params),
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (text) this.appendLog(session, text);
    });
    proc.on("error", (error) => this.onProcEnd(session, error));
    proc.on("close", (code) => this.onProcEnd(session, new Error(`${this.profile.label} exited${code === null ? "" : ` with code ${code}`}`)));
    return session;
  }

  /** initialize, then create the ACP session or continue `resumeNativeId`. */
  private async open(session: AcpSession, resumeNativeId?: string): Promise<void> {
    const init = await session.conn.request<{ agentCapabilities?: AgentCapabilities; _meta?: { modelState?: ModelState } }>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // The agent uses its own file and terminal tools; the Bridge only relays.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agent-bridge", version: "1" },
    });
    session.capabilities = init.agentCapabilities ?? {};
    const base = { cwd: session.cwd, mcpServers: [] };
    if (resumeNativeId) {
      try {
        const capabilities = session.capabilities;
        let result: Record<string, unknown>;
        if (capabilities.sessionCapabilities?.resume) {
          result = await session.conn.request("session/resume", { ...base, sessionId: resumeNativeId });
        } else if (capabilities.loadSession) {
          session.replaying = true;
          try { result = await session.conn.request("session/load", { ...base, sessionId: resumeNativeId }); }
          finally { session.replaying = false; }
        } else {
          throw new Error("agent cannot resume sessions");
        }
        session.nativeSessionId = resumeNativeId;
        this.readSessionState(session, result);
        return;
      } catch (error) {
        log.warn({ sessionId: session.sessionId, resumeNativeId, error: errorText(error) }, "ACP resume failed; starting a new session");
        this.appendLog(session, `Resume failed (${errorText(error)}); started a new ${this.profile.label} session`);
      }
    }
    const created = await session.conn.request<{ sessionId?: string }>("session/new", base);
    if (!created.sessionId) throw new Error("session/new returned no sessionId");
    session.nativeSessionId = created.sessionId;
    this.readSessionState(session, created as Record<string, unknown>);
  }

  private readSessionState(session: AcpSession, result: Record<string, unknown>): void {
    if (Array.isArray(result.configOptions)) session.config = result.configOptions as ConfigOption[];
    if (result.models && typeof result.models === "object") session.models = result.models as ModelState;
    session.model = this.option(session, "model")?.currentValue ?? session.models?.currentModelId ?? session.model;
  }

  // ---- agent → bridge ----------------------------------------------------

  private handleNotification(session: AcpSession, method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return; // vendor extensions (`_x.ai/...`) carry nothing the Bridge shows
    const update = (params.update ?? {}) as Record<string, unknown>;
    session.updatedAt = Date.now();
    switch (update.sessionUpdate) {
      case "config_option_update":
        if (Array.isArray(update.configOptions)) session.config = update.configOptions as ConfigOption[];
        session.model = this.option(session, "model")?.currentValue ?? session.model;
        return;
      case "session_info_update":
        if (typeof update.title === "string" && update.title && update.title !== session.title) {
          session.title = update.title;
          if (session.discovered && !session.replaying) { session.discovered = false; this.emitDiscovered(session); }
        }
        return;
    }
    if (session.replaying || !session.activeTurnId) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        session.messageText += contentText(update.content);
        this.setPhase(session, "writing");
        return;
      case "agent_thought_chunk":
        this.setPhase(session, "thinking");
        return;
      case "tool_call":
        this.handleToolCall(session, update);
        return;
      case "tool_call_update":
        this.handleToolCallUpdate(session, update);
        return;
      case "plan":
        if (Array.isArray(update.entries)) this.appendLog(session, `Plan: ${update.entries.map((entry) => (entry as { content?: string }).content ?? "").join("; ")}`);
        return;
    }
  }

  private async handleRequest(session: AcpSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "session/request_permission") return this.requestPermission(session, params);
    throw new AcpRpcError(-32601, `Method not found: ${method}`);
  }

  private setPhase(session: AcpSession, phase: ProgressPhase): void {
    if (phase === session.phase || !session.activeTurnId) return;
    session.phase = phase;
    this.emitSessionEvent(session, "progress", `${this.turnPrefix(session)}:progress:${randomUUID()}`,
      { phase, summary: phase === "thinking" ? "Thinking" : "Writing a reply" });
  }

  private handleToolCall(session: AcpSession, update: Record<string, unknown>): void {
    this.flushMessage(session);
    const callId = String(update.toolCallId ?? randomUUID());
    const title = String(update.title ?? "tool");
    const call: ToolCall = { title, name: title, key: `${callId}:${++session.toolCallCount}` };
    mergeToolCall(call, update);
    session.toolCalls.set(callId, call);
    session.phase = undefined;
    this.emitSessionEvent(session, "tool.started", `${this.turnPrefix(session)}:${call.key}:tool-started`,
      { name: call.name, summary: toolSummary(call) }, session.activeTurnId, call.key);
    if (update.status === "completed" || update.status === "failed") this.completeToolCall(session, callId, call, update.status);
  }

  private handleToolCallUpdate(session: AcpSession, update: Record<string, unknown>): void {
    const callId = String(update.toolCallId ?? "");
    let call = session.toolCalls.get(callId);
    if (!call) {
      // An update for a call we never saw start (the agent may skip tool_call).
      const title = String(update.title ?? "tool");
      call = { title, name: title, key: `${callId || randomUUID()}:${++session.toolCallCount}` };
      session.toolCalls.set(callId, call);
    }
    mergeToolCall(call, update);
    if (update.status === "completed" || update.status === "failed") this.completeToolCall(session, callId, call, update.status);
  }

  /** The call's result in the shape the other adapters report: a command, a file change, or a tool. */
  private completeToolCall(session: AcpSession, callId: string, call: ToolCall, outcome: "completed" | "failed"): void {
    session.toolCalls.delete(callId);
    const prefix = `${this.turnPrefix(session)}:${call.key}`;
    const output = toolOutput(call);
    const summary = toolSummary(call);
    this.appendLog(session, `${summary}${output ? `\n${truncate(output, 160)}` : ""}`);
    const input = call.rawInput ?? {};
    if (call.kind === "execute") {
      const exitCode = call.rawOutput?.exit_code;
      this.emitSessionEvent(session, "command.completed", `${prefix}:command`, {
        command: typeof input.command === "string" ? input.command : call.title,
        cwd: typeof call.rawOutput?.current_dir === "string" ? call.rawOutput.current_dir : session.cwd,
        status: outcome, exitCode: typeof exitCode === "number" ? exitCode : null, output: truncate(output),
      }, session.activeTurnId, call.key);
    } else if (call.kind === "edit" || call.kind === "delete" || call.kind === "move") {
      const paths = filePaths(call);
      this.emitSessionEvent(session, "file_change.completed", `${prefix}:file-change`, {
        changes: paths.map((path) => ({ path })),
        summary: paths.length === 1 ? `Edited ${basename(paths[0]!)}` : paths.length ? `${paths.length} file changes applied` : "File change applied",
        status: outcome,
      }, session.activeTurnId, call.key);
    } else {
      this.emitSessionEvent(session, "tool.completed", `${prefix}:tool`, {
        name: call.name, summary, status: outcome, ...(output ? { output: truncate(output, 2_000) } : {}),
      }, session.activeTurnId, call.key);
    }
  }

  // ---- approvals ---------------------------------------------------------

  private requestPermission(session: AcpSession, params: Record<string, unknown>): Promise<unknown> {
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(params.options) ? params.options : []) as Array<{ optionId: string; kind: string }>;
    if (!session.activeTurnId) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const approvalId = randomUUID();
    const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
    const kind: ApprovalKind = toolCall.kind === "execute" ? "command"
      : toolCall.kind === "edit" || toolCall.kind === "delete" || toolCall.kind === "move" ? "file-change" : "permissions";
    const title = typeof toolCall.title === "string" ? toolCall.title : "";
    const summary = title || (typeof rawInput.command === "string" ? `$ ${rawInput.command}` : `${this.profile.label} wants to use a tool`);
    const choices: ApprovalChoice[] = options.some((option) => option.kind === "allow_always")
      ? ["allow", "deny", "allow-session"] : ["allow", "deny"];
    const requestedAt = Date.now();
    return new Promise((resolve) => {
      session.approvals.set(approvalId, { approvalId, kind, summary, choices, options, turnId: session.activeTurnId, requestedAt, resolve });
      this.appendLog(session, `Approval requested: ${summary}`);
      this.emit({ type: "approval_request", sessionId: session.sessionId, approvalId, kind, summary, choices, turnId: session.activeTurnId, requestedAt });
      this.emitSessionEvent(session, "approval.requested", `approval:${approvalId}:requested`, { approvalId, kind, summary, choices });
    });
  }

  async approve(sessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void> {
    const session = this.require(sessionId);
    const approval = session.approvals.get(approvalId);
    if (!approval) throw new Error("This approval request is no longer pending");
    const preferred = choice === "deny" ? ["reject_once", "reject_always"]
      : choice === "allow-session" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"];
    const option = preferred.map((kind) => approval.options.find((o) => o.kind === kind)).find(Boolean);
    this.resolveApproval(session, approval, option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } }, choice);
    this.appendLog(session, `Approval answered: ${choice}`);
  }

  private resolveApproval(session: AcpSession, approval: PendingApproval, result: unknown, choice?: ApprovalChoice): void {
    session.approvals.delete(approval.approvalId);
    approval.resolve(result);
    this.emit({ type: "approval_resolved", sessionId: session.sessionId, approvalId: approval.approvalId, resolvedAt: Date.now() });
    this.emitSessionEvent(session, "approval.resolved", `approval:${approval.approvalId}:resolved`, { approvalId: approval.approvalId, ...(choice ? {choice} : {resolution: "cancelled"}) }, approval.turnId);
  }

  /** ACP requires answering outstanding permission requests with `cancelled` when a turn is cancelled. */
  private cancelApprovals(session: AcpSession): void {
    for (const approval of [...session.approvals.values()]) this.resolveApproval(session, approval, { outcome: { outcome: "cancelled" } });
  }

  // ---- turns -------------------------------------------------------------

  private startPrompt(session: AcpSession, text: string, images: FetchedAttachment[]): string {
    if (images.length && !session.capabilities.promptCapabilities?.image) throw domainError("image_unsupported", "This worker does not support images; no input was sent");
    const turnId = this.startTurnEvents(session);
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
    if (images.length && session.capabilities.promptCapabilities?.image) {
      for (const image of images) prompt.push({ type: "image", data: image.base64, mimeType: image.mediaType });
    } else if (images.length) {
      this.appendLog(session, `${this.profile.label} does not accept images; ${images.length} attachment(s) not sent`);
    }
    session.conn.request<{ stopReason?: string }>("session/prompt", { sessionId: session.nativeSessionId, prompt }).then(
      (result) => {
        if (session.activeTurnId !== turnId) return;
        this.flushMessage(session);
        const stop = result.stopReason;
        if (stop === "cancelled") this.finishTurn(session, "interrupted");
        else if (stop === "refusal") this.finishTurn(session, "failed", `${this.profile.label} refused the request`);
        else this.finishTurn(session, "completed", session.lastAssistantText ? truncate(session.lastAssistantText) : undefined);
      },
      (error: unknown) => {
        if (session.activeTurnId !== turnId) return;
        this.flushMessage(session);
        this.finishTurn(session, "failed", truncate(errorText(error)));
      },
    ).finally(() => this.drainQueue(session));
    return turnId;
  }

  private drainQueue(session: AcpSession): void {
    if (session.ended || session.activeTurnId) return;
    const next = session.queued.shift();
    if (next) this.startPrompt(session, next.text, next.images);
  }

  private startTurnEvents(session: AcpSession): string {
    const turnId = `${session.sessionId}:t${++session.turnSeq}:${randomUUID()}`;
    session.activeTurnId = turnId;
    session.settledAt = undefined;
    session.turnMessageSeq = 0;
    session.messageText = "";
    session.lastAssistantText = undefined;
    session.phase = undefined;
    session.toolCalls.clear();
    session.toolCallCount = 0;
    this.appendLog(session, "Turn started");
    this.emit({ type: "agent.started", sessionId: session.sessionId, timestamp: Date.now(), summary: "New turn started" });
    this.emitSessionEvent(session, "turn.started", `${this.eventPrefix(session)}:${turnId}:started`, { status: "in_progress" }, turnId);
    return turnId;
  }

  /** Report the assistant text streamed since the last tool call as one message. */
  private flushMessage(session: AcpSession): void {
    const text = session.messageText.trim();
    session.messageText = "";
    if (!text || !session.activeTurnId) return;
    this.appendLog(session, text);
    session.lastAssistantText = text;
    this.emit({ type: "agent.output", sessionId: session.sessionId, timestamp: Date.now(), text });
    this.emitSessionEvent(session, "message.completed", `${this.turnPrefix(session)}:m${++session.turnMessageSeq}:assistant`,
      { role: "assistant", text: truncate(text) });
  }

  private finishTurn(session: AcpSession, status: "completed" | "failed" | "interrupted", summary?: string): void {
    const turnId = session.activeTurnId;
    if (session.interrupting) status = "interrupted";
    session.interrupting = false;
    session.activeTurnId = undefined;
    session.settledAt = Date.now();
    session.lastTurnStatus = status;
    this.cancelApprovals(session);
    if (!turnId) return;
    const eventId = `${this.eventPrefix(session)}:${turnId}:terminal:structured`;
    if (status === "failed") {
      this.emit({ type: "agent.failed", sessionId: session.sessionId, timestamp: Date.now(), summary });
      this.emitSessionEvent(session, "turn.failed", eventId, { status, summary }, turnId);
    } else if (status === "interrupted") {
      this.emit({ type: "agent.stopped", sessionId: session.sessionId, timestamp: Date.now() });
      this.emitSessionEvent(session, "turn.interrupted", eventId, { status }, turnId);
    } else {
      this.emit({ type: "agent.completed", sessionId: session.sessionId, timestamp: Date.now(), summary });
      this.emitSessionEvent(session, "turn.completed", eventId, { status, summary }, turnId);
    }
  }

  private cancelTurn(session: AcpSession): void {
    session.queued = [];
    session.interrupting = true;
    this.cancelApprovals(session);
    session.conn.notify("session/cancel", { sessionId: session.nativeSessionId });
    this.flushMessage(session);
  }

  private onProcEnd(session: AcpSession, error: Error): void {
    session.conn.close(error);
    if (session.ended) return;
    session.ended = true;
    if (session.activeTurnId) {
      const output = session.logs.slice(-3).join("\n").trim();
      this.finishTurn(session, "failed", truncate(`${error.message}${output ? `: ${output}` : ""}`));
    }
    // A dead process cannot continue; the next turn revives the session through resumeSession.
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
  }

  private kill(session: AcpSession): void {
    session.ended = true;
    session.conn.close(new Error("session closed"));
    try { session.proc.stdin.end(); } catch { /* already closed */ }
    try { session.proc.kill("SIGTERM"); } catch { /* already dead */ }
  }

  // ---- model and effort --------------------------------------------------

  private option(session: AcpSession, category: string): ConfigOption | undefined {
    return session.config.find((option) => option.category === category);
  }

  /** Select a model and effort through ACP session config options (or the older session/set_model). */
  private async applyConfig(session: AcpSession, model?: string, effort?: string): Promise<void> {
    if (model && model !== session.model) {
      const option = this.option(session, "model");
      if (option) await this.setOption(session, option, model);
      else if (session.models) {
        await session.conn.request("session/set_model", { sessionId: session.nativeSessionId, modelId: model })
          .then(() => { session.model = model; }, (error: unknown) => this.appendLog(session, `Model switch to ${model} failed: ${errorText(error)}`));
      }
    }
    const level = effort && effort !== DEFAULT_EFFORT ? effort : undefined;
    const option = level ? this.option(session, "thought_level") : undefined;
    if (level && option) await this.setOption(session, option, level);
  }

  private async setOption(session: AcpSession, option: ConfigOption, value: string): Promise<void> {
    if (option.currentValue === value) return;
    if (option.options && !option.options.some((choice) => choice.value === value)) {
      this.appendLog(session, `${this.profile.label} has no ${option.id} "${value}"; keeping ${option.currentValue ?? "the default"}`);
      return;
    }
    try {
      const result = await session.conn.request("session/set_config_option", { sessionId: session.nativeSessionId, configId: option.id, value });
      this.readSessionState(session, result);
      this.appendLog(session, `Set ${option.id} to ${value}`);
    } catch (error) {
      this.appendLog(session, `Setting ${option.id} to ${value} failed: ${errorText(error)}`);
    }
  }

  async models(): Promise<CodexModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.models;
    this.modelQuery ??= this.queryModels().then((models) => {
      if (models.length) this.modelCache = { at: Date.now(), models };
      return models;
    }).finally(() => { this.modelQuery = undefined; });
    return this.modelQuery;
  }

  /** Read the catalog from a live session, else from a short-lived agent process. */
  private async queryModels(): Promise<CodexModelInfo[]> {
    const live = [...this.sessions.values()].find((session) => session.discovered && (session.config.length || session.models));
    if (live) return catalog(live.models, live.config);
    const probe = this.spawnSession(`${this.profile.sessionPrefix}-models`, tmpdir());
    try {
      return await withTimeout((async () => {
        const init = await probe.conn.request<{ agentCapabilities?: AgentCapabilities; _meta?: { modelState?: ModelState } }>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "agent-bridge", version: "1" },
        });
        // Grok lists its models at initialize, without creating a session.
        if (init._meta?.modelState?.availableModels?.length) return catalog(init._meta.modelState, []);
        const created = await probe.conn.request<Record<string, unknown>>("session/new", { cwd: tmpdir(), mcpServers: [] });
        const models = catalog(created.models as ModelState | undefined, (created.configOptions ?? []) as ConfigOption[]);
        if (init.agentCapabilities?.sessionCapabilities?.close && typeof created.sessionId === "string") {
          await probe.conn.request("session/close", { sessionId: created.sessionId }).catch(() => undefined);
        }
        return models;
      })(), 30_000, "Timed out reading the model catalog");
    } catch (error) {
      log.warn({ agent: this.profile.provider, error: errorText(error) }, "Unable to read the ACP model catalog");
      throw error;
    } finally {
      this.kill(probe);
    }
  }

  // ---- AgentAdapter surface ----------------------------------------------

  async input(sessionId: string, text: string, model?: string, attachments?: AttachmentRef[]): Promise<void> {
    const session = this.require(sessionId);
    const images = await this.materialize(attachments);
    if (session.activeTurnId) { session.queued.push({ text, images }); return; }
    await this.applyConfig(session, model);
    this.startPrompt(session, text, images);
  }

  async createSessionAction(actionId: string, projectPath: string, input?: string, model?: string, reasoningEffort?: string, attachments?: AttachmentRef[]): Promise<{ sessionId: string; turnId?: string }> {
    const sessionId = await this.startSession(actionId, projectPath, input, undefined, model, attachments, reasoningEffort);
    return { sessionId, turnId: this.sessions.get(sessionId)?.activeTurnId };
  }

  async submitTurnAction(
    actionId: string,
    sessionId: string,
    text: string,
    delivery: "auto" | "steer" | "start_turn",
    expectedTurnId?: string,
    model?: string,
    reasoningEffort?: string,
    attachments?: AttachmentRef[],
  ): Promise<{ sessionId: string; turnId?: string; resolvedAction: "steer" | "start_turn" }> {
    const images = await this.materialize(attachments);
    const session = this.require(sessionId);
    const activeTurnId = session.activeTurnId;
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    if (delivery === "steer" && !activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (delivery === "steer") throw domainError("steer_unsupported", `${this.profile.label} cannot add input to a running turn`);
    if (delivery === "start_turn" && activeTurnId) throw domainError("turn_already_active", "session already has an active turn");
    this.emitSessionEvent(session, "message.completed", `${this.eventPrefix(session)}:action:${actionId}:user`, { role: "user", text: truncate(text) }, activeTurnId);
    if (activeTurnId) {
      // ACP has no steering: the message runs as the next turn once this one ends.
      session.queued.push({ text, images });
      return { sessionId, resolvedAction: "start_turn" };
    }
    await this.applyConfig(session, model, reasoningEffort);
    return { sessionId, turnId: this.startPrompt(session, text, images), resolvedAction: "start_turn" };
  }

  async interruptAction(sessionId: string, expectedTurnId?: string): Promise<{ sessionId: string; turnId: string }> {
    const session = this.require(sessionId);
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    this.cancelTurn(session);
    try { await waitForTurnSettlement(() => session.activeTurnId, activeTurnId, this.settleTimeoutMs); }
    catch {
      // The agent ignored session/cancel: end the process; the next turn revives the session.
      log.warn({ sessionId, turnId: activeTurnId }, "ACP agent did not settle a cancelled turn; killing its process");
      this.kill(session);
      this.finishTurn(session, "interrupted");
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    }
    return { sessionId, turnId: activeTurnId };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (!session.activeTurnId) throw new Error(`Session ${sessionId} has no active turn`);
    await this.interruptAction(sessionId, session.activeTurnId);
  }

  async deleteSessionAction(sessionId: string): Promise<{ sessionId: string }> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.kill(session);
      this.sessions.delete(sessionId);
    }
    return { sessionId };
  }

  async respondUserInput(_sessionId: string, _publicId: string, _answers: Record<string, { answers: string[] }>): Promise<void> {
    // ACP has no structured user-input request; agents ask in plain text.
  }

  async reconcileActivity(): Promise<void> {
    /* activity is tracked live from each session's stream */
  }

  /** Close the subprocess of sessions idle for `idleMs`; the next turn resumes them. Non-positive disables reaping. */
  reapIdleSessions(idleMs: number): string[] {
    if (idleMs <= 0) return [];
    const now = Date.now();
    const reaped: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.ended || session.activeTurnId || session.settledAt === undefined || now - session.settledAt < idleMs) continue;
      this.kill(session);
      this.sessions.delete(id);
      reaped.push(id);
      log.info({ sessionId: id, agent: this.profile.provider }, "reaped idle ACP session; subprocess closed");
    }
    return reaped;
  }

  stateSnapshot(): { sessions: SessionState[]; approvals: Array<Record<string, unknown>>; userInputs: Array<Record<string, unknown>> } {
    const live = [...this.sessions.values()].filter((s) => s.discovered);
    const sessions: SessionState[] = live.map((s) => ({
      sessionId: s.sessionId,
      nativeSessionId: s.nativeSessionId,
      agentType: this.profile.agentType,
      projectPath: s.cwd,
      projectName: basename(s.cwd),
      title: s.title ?? s.promptSummary,
      promptSummary: s.promptSummary,
      activityStatus: s.approvals.size ? "waiting_for_approval" as const : s.activeTurnId ? "active" as const : "idle" as const,
      activeTurnId: s.activeTurnId,
      lastTurnStatus: s.lastTurnStatus,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      source: "acp" as const,
      historyCompleteness: "terminal-only" as const,
      projectIdentity: s.projectIdentity,
    }));
    const approvals = live.flatMap((s) => [...s.approvals.values()].map((a) => ({
      approvalId: a.approvalId, sessionId: s.sessionId, turnId: a.turnId, kind: a.kind, summary: a.summary, choices: a.choices, requestedAt: a.requestedAt,
    })));
    return { sessions, approvals, userInputs: [] };
  }

  logs(sessionId: string, count: number): string {
    return this.sessions.get(sessionId)?.logs.slice(-count).join("\n") || "No structured events captured yet.";
  }

  hasActiveSessions(): boolean {
    return [...this.sessions.values()].some((s) => s.activeTurnId || s.approvals.size);
  }

  sessionActivity(): { activeSessionIds: string[]; waitingSessionIds: string[]; blockedSessionIds: string[] } {
    const sessions = [...this.sessions.values()];
    return {
      activeSessionIds: sessions.filter((s) => s.activeTurnId).map((s) => s.sessionId),
      waitingSessionIds: [],
      blockedSessionIds: sessions.filter((s) => s.approvals.size).map((s) => s.sessionId),
    };
  }

  // ---- helpers -----------------------------------------------------------

  private emitDiscovered(session: AcpSession): void {
    if (session.discovered) return;
    session.discovered = true;
    this.emit({
      type: "session.discovered",
      requestId: session.requestId,
      sessionId: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      agentType: this.profile.agentType,
      projectPath: session.cwd,
      projectName: basename(session.cwd),
      title: session.title ?? session.promptSummary,
      promptSummary: session.promptSummary,
      status: session.activeTurnId ? "working" : "waiting",
      createdAt: session.createdAt,
      model: session.model,
      projectIdentity: session.projectIdentity,
    });
  }

  /** Fetch image attachments; whether they are sent depends on the agent's prompt capabilities. */
  private async materialize(attachments?: AttachmentRef[]): Promise<FetchedAttachment[]> {
    if (!attachments?.length) return [];
    if (!this.options.fetchAttachment) throw new Error("attachment_unavailable");
    if (attachments.some(ref => !ref.mimeType.startsWith("image/"))) throw new Error("This worker accepts image attachments only");
    return Promise.all(attachments.map(ref => this.options.fetchAttachment!(ref)));
  }

  private require(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ${this.profile.label} session: ${sessionId}`);
    return session;
  }

  private eventPrefix(session: AcpSession): string {
    return `${this.profile.sessionPrefix}:${session.sessionId}`;
  }

  private turnPrefix(session: AcpSession): string {
    return `${this.eventPrefix(session)}:${session.activeTurnId ?? randomUUID()}`;
  }

  private appendLog(session: AcpSession, text: string): void {
    session.logs.push(...text.split("\n"));
    if (session.logs.length > LOG_LIMIT) session.logs.splice(0, session.logs.length - LOG_LIMIT);
  }

  private emitSessionEvent(session: AcpSession, eventType: StructuredSessionEventType, eventId: string, payload: Record<string, unknown>, turnId = session.activeTurnId, itemId?: string): void {
    this.emit({ type: "session.event", eventType, sessionId: session.sessionId, eventId, timestamp: Date.now(), turnId, ...(itemId ? { itemId } : {}), payload });
  }
}

// ---- module helpers ------------------------------------------------------

/** The catalog in CodexModelInfo shape, from ACP model state or the model/thought_level config options. */
export function catalog(models: ModelState | undefined, config: ConfigOption[]): CodexModelInfo[] {
  const efforts = config.find((option) => option.category === "thought_level")?.options
    ?.map((choice) => ({ reasoningEffort: choice.value, description: choice.name ?? choice.description }));
  const defaultEffort = config.find((option) => option.category === "thought_level")?.currentValue;
  if (models?.availableModels?.length) {
    return models.availableModels.map((model) => {
      const own = model._meta?.reasoningEfforts?.map((effort) => ({ value: effort.value ?? effort.id ?? "", label: effort.label, default: effort.default }))
        .filter((effort) => effort.value);
      return {
        id: model.modelId,
        model: model.modelId,
        displayName: model.name ?? model.modelId,
        isDefault: model.modelId === models.currentModelId,
        defaultReasoningEffort: own?.find((effort) => effort.default)?.value ?? defaultEffort,
        supportedReasoningEfforts: own?.length ? own.map((effort) => ({ reasoningEffort: effort.value, description: effort.label })) : efforts,
      };
    });
  }
  const option = config.find((candidate) => candidate.category === "model");
  return (option?.options ?? []).map((choice) => ({
    id: choice.value,
    model: choice.value,
    displayName: choice.name ?? choice.value,
    isDefault: choice.value === option?.currentValue,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts,
  }));
}

function mergeToolCall(call: ToolCall, update: Record<string, unknown>): void {
  if (typeof update.title === "string" && update.title) call.title = update.title;
  if (typeof update.kind === "string") call.kind = update.kind;
  if (update.rawInput && typeof update.rawInput === "object") call.rawInput = update.rawInput as Record<string, unknown>;
  if (update.rawOutput && typeof update.rawOutput === "object") call.rawOutput = update.rawOutput as Record<string, unknown>;
  if (Array.isArray(update.content)) call.content = update.content;
  if (Array.isArray(update.locations)) call.locations = update.locations as Array<{ path?: string }>;
}

function contentText(content: unknown): string {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** The call's text output: its content blocks, else a textual raw output. */
function toolOutput(call: ToolCall): string {
  const text = (call.content ?? []).map((block) => {
    const item = block as { type?: string; content?: unknown };
    return item.type === "content" ? contentText(item.content) : "";
  }).filter(Boolean).join("\n");
  if (text) return text;
  const raw = call.rawOutput;
  for (const key of ["output_for_prompt", "output", "stdout"]) {
    if (typeof raw?.[key] === "string" && raw[key]) return raw[key] as string;
  }
  return "";
}

function filePaths(call: ToolCall): string[] {
  const paths = (call.content ?? []).map((block) => (block as { type?: string; path?: string }).type === "diff" ? (block as { path?: string }).path : undefined);
  paths.push(...(call.locations ?? []).map((location) => location.path));
  const input = call.rawInput ?? {};
  for (const key of ["path", "file_path"]) if (typeof input[key] === "string") paths.push(input[key] as string);
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function toolSummary(call: ToolCall): string {
  if (call.kind === "execute" && typeof call.rawInput?.command === "string") return `$ ${call.rawInput.command}`;
  return call.title;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit = 4_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function domainError(code: string, message: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable: false });
}
