import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import pino from "pino";
import type {
  ApprovalChoice,
  ApprovalKind,
  SessionState,
  StructuredSessionEventType,
  UserInputQuestion,
} from "@agent-bridge/protocol";
import type { AgentAdapter, AdapterEmit } from "../agent-adapter.js";
import { resolveProjectPath, summarizePrompt } from "../app-server.js";
import { PushableAsyncIterable, query, type Query } from "./sdk/index.js";
import type {
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "./sdk/types.js";

const log = pino({ name: "claude-adapter" });
const execFileAsync = promisify(execFile);

const FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LOG_LIMIT = 2_000;

interface PendingApproval {
  approvalId: string;
  toolName: string;
  kind: ApprovalKind;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  answered: boolean;
  requestedAt: number;
  turnId?: string;
}

interface PendingUserInput {
  publicId: string;
  questions: UserInputQuestion[];
  resolve: (result: PermissionResult) => void;
  requestedAt: number;
  originalInput: Record<string, unknown>;
  turnId?: string;
}

interface ClaudeSession {
  sessionId: string; // native Claude session id (uuid); starts as a temp id until system/init
  requestId?: string; // bridge-side start id (run id / action id) used to link discovered session to its run
  cwd: string;
  projectPath: string;
  projectIdentity?: string;
  title?: string;
  promptSummary?: string;
  createdAt: number;
  updatedAt: number;
  discovered: boolean;
  input: PushableAsyncIterable<SDKUserMessage>;
  query?: Query;
  abort: AbortController;
  activeTurnId?: string;
  turnSeq: number;
  /** First-turn prompt was pushed before init; emit its turn-start events once discovered. */
  pendingTurnStart: boolean;
  lastTurnStatus?: "completed" | "failed" | "interrupted";
  logs: string[];
  toolUses: Map<string, { name: string; input: Record<string, unknown> }>;
  pendingApprovals: Map<string, PendingApproval>;
  pendingUserInput?: PendingUserInput;
  sessionAllowedTools: Set<string>;
  resolveInit?: (sessionId: string) => void;
  ended: boolean;
}

/**
 * Drives Claude Code via one `claude` subprocess per session, translating the
 * stream-json protocol into the bridge's normalized event stream. Mirrors the
 * event shapes emitted by {@link CodexAppServerAdapter} so downstream consumers
 * (control-plane, DB, DSH, Matrix) are agent-agnostic.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, ClaudeSession>();
  private ready = false;

  constructor(
    private readonly options: {
      command: string;
      claudeHome: string;
      allowedRoots: string[];
      scanExisting: boolean;
    },
    private readonly emit: AdapterEmit,
  ) {}

  async start(): Promise<void> {
    if (this.options.command) process.env.CLAUDE_COMMAND = this.options.command;
    if (this.options.scanExisting) {
      try {
        await this.scanExistingSessions();
      } catch (error) {
        log.warn({ error }, "Unable to scan existing Claude sessions");
      }
    }
    this.ready = true;
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      session.ended = true;
      session.abort.abort();
      try {
        session.input.end();
      } catch {
        /* already ended */
      }
      for (const approval of session.pendingApprovals.values()) {
        if (!approval.answered) approval.resolve({ behavior: "deny", message: "bridge shutting down" });
      }
      session.pendingUserInput?.resolve({ behavior: "deny", message: "bridge shutting down" });
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  // ---- session lifecycle -------------------------------------------------

  async startSession(requestId: string, projectPath: string, prompt?: string, resumeSessionId?: string, model?: string): Promise<string> {
    const cwd = await resolveProjectPath(projectPath, this.options.allowedRoots);
    const tempId = resumeSessionId ?? `pending:${requestId}`;
    const session: ClaudeSession = {
      sessionId: tempId,
      requestId,
      cwd,
      projectPath: cwd,
      projectIdentity: await deriveProjectIdentity(cwd),
      promptSummary: summarizePrompt(prompt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      discovered: false,
      input: new PushableAsyncIterable<SDKUserMessage>(),
      abort: new AbortController(),
      turnSeq: 0,
      pendingTurnStart: false,
      logs: [],
      toolUses: new Map(),
      pendingApprovals: new Map(),
      sessionAllowedTools: new Set(),
      ended: false,
    };
    this.sessions.set(tempId, session);

    const initPromise = new Promise<string>((resolve) => {
      session.resolveInit = resolve;
    });

    session.query = query({
      prompt: session.input,
      options: {
        cwd,
        resume: resumeSessionId,
        model,
        abort: session.abort.signal,
        canCallTool: (toolName, input, opts) => this.handleToolPermission(session, toolName, input, opts.signal),
      },
    });

    // Consume the stream in the background; startSession only awaits init.
    void this.consume(session).catch((error) => {
      if (!session.ended) log.error({ error, sessionId: session.sessionId }, "Claude session stream failed");
    });

    // Push the first prompt immediately so Claude begins (and emits init), but
    // defer the turn-start events until after session.discovered is emitted
    // (on init) so downstream sees discovered before any turn events.
    if (prompt) {
      session.input.push(userMessage(prompt));
      session.pendingTurnStart = true;
    }

    // Wait until Claude reports its real session id (first system/init).
    const nativeId = await Promise.race([
      initPromise,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Claude session init")), 60_000)),
    ]);
    return nativeId;
  }

  private async consume(session: ClaudeSession): Promise<void> {
    if (!session.query) return;
    try {
      for await (const message of session.query) {
        this.handleMessage(session, message);
      }
    } finally {
      // Stream exhausted: any active turn is done. Emit a terminal event if one
      // is still open (e.g. process exit without a final result).
      if (session.activeTurnId) this.finishTurn(session, "completed");
    }
  }

  private handleMessage(session: ClaudeSession, message: SDKMessage): void {
    switch (message.type) {
      case "system":
        this.handleSystem(session, message as SDKSystemMessage);
        break;
      case "assistant":
        this.handleAssistant(session, message as SDKAssistantMessage);
        break;
      case "user":
        this.handleUser(session, message as SDKUserMessage);
        break;
      case "result":
        this.handleResult(session, message as SDKResultMessage);
        break;
      default:
        break;
    }
  }

  private handleSystem(session: ClaudeSession, message: SDKSystemMessage): void {
    if (message.subtype !== "init" || !message.session_id) return;
    const nativeId = message.session_id;
    if (session.sessionId !== nativeId) {
      this.sessions.delete(session.sessionId);
      session.sessionId = nativeId;
      this.sessions.set(nativeId, session);
    }
    if (!session.discovered) {
      session.discovered = true;
      this.emit({
        type: "session.discovered",
        requestId: session.requestId,
        sessionId: nativeId,
        nativeSessionId: nativeId,
        agentType: "claude-code",
        projectPath: session.projectPath,
        projectName: basename(session.projectPath),
        title: session.title,
        promptSummary: session.promptSummary,
        status: session.activeTurnId ? "working" : "waiting",
        createdAt: session.createdAt,
        projectIdentity: session.projectIdentity,
      });
    }
    if (session.pendingTurnStart && !session.activeTurnId) {
      session.pendingTurnStart = false;
      this.startTurnEvents(session);
    }
    session.resolveInit?.(nativeId);
    session.resolveInit = undefined;
  }

  private handleAssistant(session: ClaudeSession, message: SDKAssistantMessage): void {
    session.updatedAt = Date.now();
    for (const block of message.message.content ?? []) {
      if (block.type === "text" && block.text) {
        this.appendLog(session, block.text);
        this.emit({ type: "agent.output", sessionId: session.sessionId, timestamp: Date.now(), text: block.text });
        this.emitSessionEvent(session, "message.completed", `claude:${session.sessionId}:${blockId(block)}:message`, {
          role: "assistant",
          text: truncate(block.text),
        });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        session.toolUses.set(block.id, { name: block.name ?? "tool", input: (block.input as Record<string, unknown>) ?? {} });
      }
    }
  }

  private handleUser(session: ClaudeSession, message: SDKUserMessage): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = session.toolUses.get(block.tool_use_id);
      session.toolUses.delete(block.tool_use_id);
      const name = tool?.name ?? "tool";
      const output = extractToolResultText(block.content);
      const isError = block.is_error === true;
      if (name === "Bash") {
        const command = String(tool?.input?.command ?? "command");
        const summary = `$ ${command}`;
        this.appendLog(session, `${summary}${output ? `\n${output}` : ""}`);
        if (isError) this.emit({ type: "agent.progress", sessionId: session.sessionId, timestamp: Date.now(), summary });
        this.emitSessionEvent(session, "command.completed", `claude:${session.sessionId}:${block.tool_use_id}:command`, {
          command,
          cwd: session.cwd,
          status: isError ? "failed" : "completed",
          exitCode: null,
          output: truncate(output),
        });
      } else if (FILE_CHANGE_TOOLS.has(name)) {
        const filePath = String(tool?.input?.file_path ?? tool?.input?.notebook_path ?? "");
        const summary = filePath ? `Edited ${basename(filePath)}` : "File change applied";
        this.appendLog(session, summary);
        this.emit({ type: "agent.progress", sessionId: session.sessionId, timestamp: Date.now(), summary });
        this.emitSessionEvent(session, "file_change.completed", `claude:${session.sessionId}:${block.tool_use_id}:file-change`, {
          changes: filePath ? [{ path: filePath }] : [],
          summary,
          status: isError ? "failed" : "completed",
        });
      }
    }
  }

  private handleResult(session: ClaudeSession, message: SDKResultMessage): void {
    session.updatedAt = Date.now();
    const failed = message.is_error || message.subtype !== "success";
    this.finishTurn(session, failed ? "failed" : "completed", message.result);
  }

  // ---- turn management ---------------------------------------------------

  private beginTurn(session: ClaudeSession, text: string): void {
    if (session.activeTurnId) {
      // Active turn: steer by pushing another user message (queued as next input).
      session.input.push(userMessage(text));
      return;
    }
    this.startTurnEvents(session);
    session.input.push(userMessage(text));
  }

  /** Assign a turn id and emit agent.started + turn.started. */
  private startTurnEvents(session: ClaudeSession): string {
    const turnId = `${session.sessionId}:t${++session.turnSeq}`;
    session.activeTurnId = turnId;
    this.appendLog(session, "Turn started");
    this.emit({ type: "agent.started", sessionId: session.sessionId, timestamp: Date.now(), summary: "New turn started" });
    this.emitSessionEvent(session, "turn.started", `claude:${session.sessionId}:${turnId}:started`, { status: "in_progress" });
    return turnId;
  }

  private finishTurn(session: ClaudeSession, status: "completed" | "failed" | "interrupted", summary?: string): void {
    const turnId = session.activeTurnId;
    session.activeTurnId = undefined;
    session.lastTurnStatus = status;
    if (!turnId) return;
    const eventId = `claude:${session.sessionId}:${turnId}:terminal`;
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

  // ---- input / actions ---------------------------------------------------

  async input(sessionId: string, text: string, _model?: string): Promise<void> {
    // Claude's model is fixed at query start; mid-session model overrides are ignored.
    const session = this.require(sessionId);
    if (session.pendingUserInput) {
      // Interpret free text as the answer to the pending question(s).
      const answers = mapFreeTextAnswer(session.pendingUserInput.questions, text);
      this.resolveUserInput(session, session.pendingUserInput.publicId, answers);
      return;
    }
    this.beginTurn(session, text);
  }

  async createSessionAction(actionId: string, projectPath: string, input?: string, model?: string): Promise<{ sessionId: string; turnId?: string }> {
    const sessionId = await this.startSession(actionId, projectPath, input, undefined, model);
    return { sessionId, turnId: this.sessions.get(sessionId)?.activeTurnId };
  }

  async submitTurnAction(
    actionId: string,
    sessionId: string,
    text: string,
    delivery: "auto" | "steer" | "start_turn",
    expectedTurnId?: string,
    _model?: string,
    _reasoningEffort?: string,
  ): Promise<{ sessionId: string; turnId?: string; resolvedAction: "steer" | "start_turn" }> {
    const session = this.require(sessionId);
    if (session.pendingUserInput) throw domainError("user_input_pending", "structured user input is pending");
    if ([...session.pendingApprovals.values()].some((a) => !a.answered)) throw domainError("approval_pending", "approval is pending");
    const activeTurnId = session.activeTurnId;
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    if (delivery === "steer" && !activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (delivery === "start_turn" && activeTurnId) throw domainError("turn_already_active", "session already has an active turn");
    const resolvedAction = activeTurnId ? "steer" : "start_turn";
    this.beginTurn(session, text);
    this.emitSessionEvent(session, "message.completed", `claude:${sessionId}:action:${actionId}:user`, { role: "user", text: truncate(text) });
    return { sessionId, turnId: session.activeTurnId, resolvedAction };
  }

  async interruptAction(sessionId: string, expectedTurnId?: string): Promise<{ sessionId: string; turnId: string }> {
    const session = this.require(sessionId);
    const activeTurnId = session.activeTurnId;
    if (!activeTurnId) throw domainError("no_active_turn", "session has no active turn");
    if (expectedTurnId && expectedTurnId !== activeTurnId) throw domainError("turn_changed", "active turn changed");
    await session.query?.interrupt().catch(() => session.abort.abort());
    this.finishTurn(session, "interrupted");
    return { sessionId, turnId: activeTurnId };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (!session.activeTurnId) throw new Error(`Session ${sessionId} has no active turn`);
    await session.query?.interrupt().catch(() => session.abort.abort());
    this.finishTurn(session, "interrupted");
  }

  async deleteSessionAction(sessionId: string): Promise<{ sessionId: string }> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ended = true;
      session.abort.abort();
      try {
        session.input.end();
      } catch {
        /* already ended */
      }
      this.sessions.delete(sessionId);
    }
    return { sessionId };
  }

  /** Claude Code does not expose an enumerable model catalog through this transport. */
  async models(): Promise<never[]> {
    return [];
  }

  /** No long-lived server to reconcile against; activity is tracked live from the stream. */
  async reconcileActivity(): Promise<void> {
    /* no-op */
  }

  // ---- approvals ---------------------------------------------------------

  private handleToolPermission(
    session: ClaudeSession,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const toolInput = (input as Record<string, unknown>) ?? {};
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(session, toolInput);
    }
    if (session.sessionAllowedTools.has(toolName)) {
      return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
    }
    const approvalId = randomUUID();
    const kind = approvalKindForTool(toolName);
    const summary = approvalSummaryForTool(toolName, toolInput);
    const requestedAt = Date.now();
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingApproval = {
        approvalId,
        toolName,
        kind,
        input: toolInput,
        resolve,
        answered: false,
        requestedAt,
        turnId: session.activeTurnId,
      };
      session.pendingApprovals.set(approvalId, pending);
      this.appendLog(session, summary);
      this.emit({
        type: "approval_request",
        sessionId: session.sessionId,
        approvalId,
        kind,
        summary,
        choices: ["allow", "deny", "allow-session"],
        turnId: session.activeTurnId,
        requestedAt,
      });
      this.emitSessionEvent(session, "approval.requested", `approval:${approvalId}:requested`, { approvalId, kind, summary, choices: ["allow", "deny", "allow-session"] }, session.activeTurnId);
      const onAbort = () => {
        if (pending.answered) return;
        pending.answered = true;
        session.pendingApprovals.delete(approvalId);
        resolve({ behavior: "deny", message: "cancelled" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async approve(sessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void> {
    const session = this.require(sessionId);
    const approval = session.pendingApprovals.get(approvalId);
    if (!approval || approval.answered) throw new Error("This approval request is no longer pending");
    approval.answered = true;
    session.pendingApprovals.delete(approvalId);
    if (choice === "deny") {
      approval.resolve({ behavior: "deny", message: "denied by operator" });
    } else {
      if (choice === "allow-session") session.sessionAllowedTools.add(approval.toolName);
      approval.resolve({ behavior: "allow", updatedInput: approval.input });
    }
    this.appendLog(session, `Approval answered: ${choice}`);
    this.emit({ type: "approval_resolved", sessionId, approvalId, resolvedAt: Date.now() });
    this.emitSessionEvent(session, "approval.resolved", `approval:${approvalId}:resolved`, { approvalId, choice }, approval.turnId);
  }

  // ---- structured user input (AskUserQuestion) ---------------------------

  private handleAskUserQuestion(session: ClaudeSession, input: Record<string, unknown>): Promise<PermissionResult> {
    const rawQuestions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const questions: UserInputQuestion[] = rawQuestions.map((q, index) => ({
      id: `q${index}`,
      header: String(q.header ?? `Question ${index + 1}`),
      question: String(q.question ?? ""),
      isOther: true,
      isSecret: false,
      options: Array.isArray(q.options)
        ? (q.options as Array<Record<string, unknown>>).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") }))
        : null,
    }));
    const publicId = randomUUID();
    const requestedAt = Date.now();
    return new Promise<PermissionResult>((resolve) => {
      session.pendingUserInput = { publicId, questions, resolve, requestedAt, originalInput: input, turnId: session.activeTurnId };
      this.appendLog(session, `Claude is asking: ${questions.map((q) => q.question).join(" | ")}`);
      this.emit({ type: "agent.waiting", sessionId: session.sessionId, timestamp: Date.now(), summary: questions.map((q) => q.header).join(", ") });
      this.emit({ type: "user_input_request", sessionId: session.sessionId, requestId: publicId, turnId: session.activeTurnId, questions, requestedAt });
      this.emitSessionEvent(session, "user_input.requested", `user-input:${publicId}:requested`, { requestId: publicId, questions }, session.activeTurnId);
    });
  }

  async respondUserInput(sessionId: string, publicId: string, answers: Record<string, { answers: string[] }>): Promise<void> {
    const session = this.require(sessionId);
    if (!session.pendingUserInput || session.pendingUserInput.publicId !== publicId) {
      throw domainError("user_input_already_resolved", "user input is no longer pending");
    }
    this.resolveUserInput(session, publicId, answers);
  }

  private resolveUserInput(session: ClaudeSession, publicId: string, answers: Record<string, { answers: string[] }>): void {
    const pending = session.pendingUserInput;
    if (!pending || pending.publicId !== publicId) return;
    session.pendingUserInput = undefined;
    // Inject the chosen answers back into the AskUserQuestion tool input so
    // Claude receives them as the tool result and continues the turn.
    const answered = pending.questions.map((q) => ({
      header: q.header,
      question: q.question,
      answer: (answers[q.id]?.answers ?? []).join(", "),
    }));
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.originalInput, answers: answered } });
    this.emit({ type: "user_input_resolved", sessionId: session.sessionId, requestId: publicId, resolvedAt: Date.now() });
    this.emitSessionEvent(session, "user_input.resolved", `user-input:${publicId}:resolved`, { requestId: publicId }, pending.turnId);
  }

  // ---- snapshot / activity ----------------------------------------------

  stateSnapshot(): { sessions: SessionState[]; approvals: Array<Record<string, unknown>>; userInputs: Array<Record<string, unknown>> } {
    const sessions: SessionState[] = [...this.sessions.values()]
      .filter((s) => s.discovered)
      .map((s) => ({
        sessionId: s.sessionId,
        nativeSessionId: s.sessionId,
        agentType: "claude-code" as const,
        projectPath: s.projectPath,
        projectName: basename(s.projectPath),
        title: s.title,
        promptSummary: s.promptSummary,
        activityStatus: s.pendingUserInput
          ? ("waiting_for_input" as const)
          : [...s.pendingApprovals.values()].some((a) => !a.answered)
            ? ("waiting_for_approval" as const)
            : s.activeTurnId
              ? ("active" as const)
              : ("idle" as const),
        activeTurnId: s.activeTurnId,
        lastTurnStatus: s.lastTurnStatus,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        source: "claude-cli" as const,
        historyCompleteness: "terminal-only" as const,
        projectIdentity: s.projectIdentity,
      }));
    const approvals = [...this.sessions.values()].flatMap((s) =>
      [...s.pendingApprovals.values()]
        .filter((a) => !a.answered)
        .map((a) => ({ approvalId: a.approvalId, sessionId: s.sessionId, turnId: a.turnId, kind: a.kind, summary: approvalSummaryForTool(a.toolName, a.input), choices: ["allow", "deny", "allow-session"], requestedAt: a.requestedAt })),
    );
    const userInputs = [...this.sessions.values()]
      .filter((s) => s.pendingUserInput)
      .map((s) => ({ requestId: s.pendingUserInput!.publicId, sessionId: s.sessionId, turnId: s.pendingUserInput!.turnId, questions: s.pendingUserInput!.questions, requestedAt: s.pendingUserInput!.requestedAt }));
    return { sessions, approvals, userInputs };
  }

  logs(sessionId: string, count: number): string {
    return this.sessions.get(sessionId)?.logs.slice(-count).join("\n") || "No structured events captured yet.";
  }

  hasActiveSessions(): boolean {
    for (const s of this.sessions.values()) {
      if (s.activeTurnId || s.pendingUserInput || [...s.pendingApprovals.values()].some((a) => !a.answered)) return true;
    }
    return false;
  }

  sessionActivity(): { activeSessionIds: string[]; waitingSessionIds: string[]; blockedSessionIds: string[] } {
    const activeSessionIds: string[] = [];
    const waitingSessionIds: string[] = [];
    const blockedSessionIds: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.pendingUserInput) waitingSessionIds.push(s.sessionId);
      if ([...s.pendingApprovals.values()].some((a) => !a.answered)) blockedSessionIds.push(s.sessionId);
      if (s.activeTurnId || s.pendingUserInput || [...s.pendingApprovals.values()].some((a) => !a.answered)) activeSessionIds.push(s.sessionId);
    }
    return { activeSessionIds: [...new Set(activeSessionIds)], waitingSessionIds, blockedSessionIds };
  }

  // ---- inventory ---------------------------------------------------------

  private async scanExistingSessions(): Promise<void> {
    const projectsDir = join(this.options.claudeHome, "projects");
    let entries: string[];
    try {
      entries = readdirSync(projectsDir);
    } catch {
      return; // no history yet
    }
    for (const dir of entries) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const nativeId = file.replace(/\.jsonl$/, "");
        if (this.sessions.has(nativeId)) continue;
        const meta = readSessionMeta(join(projectsDir, dir, file));
        if (!meta?.cwd) continue;
        let projectPath: string;
        try {
          projectPath = await resolveProjectPath(meta.cwd, this.options.allowedRoots);
        } catch {
          continue; // outside allowed roots
        }
        this.emit({
          type: "session.discovered",
          sessionId: nativeId,
          nativeSessionId: nativeId,
          agentType: "claude-code",
          projectPath,
          projectName: basename(projectPath),
          promptSummary: summarizePrompt(meta.firstUserText),
          status: "waiting",
          createdAt: meta.createdAt ?? Date.now(),
        });
      }
    }
  }

  // ---- helpers -----------------------------------------------------------

  private require(sessionId: string): ClaudeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Claude session: ${sessionId}`);
    return session;
  }

  private appendLog(session: ClaudeSession, text: string): void {
    session.logs.push(...text.split("\n"));
    if (session.logs.length > LOG_LIMIT) session.logs.splice(0, session.logs.length - LOG_LIMIT);
  }

  private emitSessionEvent(session: ClaudeSession, eventType: StructuredSessionEventType, eventId: string, payload: Record<string, unknown>, turnId?: string): void {
    this.emit({ type: "session.event", eventType, sessionId: session.sessionId, eventId, timestamp: Date.now(), turnId, payload });
  }
}

// ---- module helpers ------------------------------------------------------

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text } };
}

function approvalKindForTool(toolName: string): ApprovalKind {
  if (toolName === "Bash") return "command";
  if (FILE_CHANGE_TOOLS.has(toolName)) return "file-change";
  return "permissions";
}

function approvalSummaryForTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") return `$ ${String(input.command ?? "")}`.trim();
  if (FILE_CHANGE_TOOLS.has(toolName)) return `${toolName} ${String(input.file_path ?? input.notebook_path ?? "")}`.trim();
  return `${toolName} requested`;
}

function truncate(text: string, limit = 4_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function blockId(block: { id?: string; text?: string }): string {
  if (block.id) return block.id;
  return createHash("sha256").update(block.text ?? "").digest("hex").slice(0, 24);
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function mapFreeTextAnswer(questions: UserInputQuestion[], text: string): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  for (const q of questions) result[q.id] = { answers: [text] };
  return result;
}

function domainError(code: string, message: string): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable: false });
}

async function deriveProjectIdentity(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
    const url = stdout.trim();
    return url ? normalizeGitRemote(url) : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize a git remote to a stable cross-machine key, e.g. github.com/org/repo. */
function normalizeGitRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

interface SessionMeta {
  cwd?: string;
  createdAt?: number;
  firstUserText?: string;
}

/** Read cwd / first user prompt from the head of a Claude transcript .jsonl. */
function readSessionMeta(path: string): SessionMeta | undefined {
  let head: string;
  try {
    head = readFileSync(path, "utf8").slice(0, 64 * 1024);
  } catch {
    return undefined;
  }
  const meta: SessionMeta = {};
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!meta.cwd && typeof row.cwd === "string") meta.cwd = row.cwd;
    if (!meta.createdAt && typeof row.timestamp === "string") {
      const t = Date.parse(row.timestamp);
      if (!Number.isNaN(t)) meta.createdAt = t;
    }
    if (!meta.firstUserText && row.type === "user") {
      const msg = row.message as { content?: unknown } | undefined;
      if (typeof msg?.content === "string") meta.firstUserText = msg.content;
    }
    if (meta.cwd && meta.firstUserText) break;
  }
  return meta;
}
