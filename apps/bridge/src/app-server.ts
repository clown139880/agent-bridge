import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import WebSocket from "ws";
import type {
  AgentEvent,
  ApprovalChoice,
  ApprovalKind,
  BridgeToControlMessage,
  SessionDiscoveredMessage,
} from "@agent-bridge/protocol";
import { CodexDesktopSessionScanner } from "./desktop-sessions.js";

const log = pino({ name: "codex-app-server" });
const execFileAsync = promisify(execFile);

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CodexThread {
  id: string;
  cwd: string;
  preview?: string;
  name?: string | null;
  createdAt?: number;
  parentThreadId?: string | null;
  status?: { type?: string; activeFlags?: string[] };
}

interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  durationMs?: number | null;
  error?: { message?: string } | null;
  items?: ThreadItem[];
}

interface ThreadItem {
  type: string;
  text?: string;
  phase?: string | null;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  tool?: string;
  server?: string;
  error?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface UserInputOption {
  label: string;
  description: string;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

interface PendingUserInput {
  requestId: number | string;
  questions: UserInputQuestion[];
}

interface PendingApproval {
  requestId: number | string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  answered: boolean;
}

export class CodexAppServerAdapter {
  private socket?: WebSocket;
  private child?: ChildProcess;
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly pendingUserInput = new Map<string, PendingUserInput>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly activeTurns = new Map<string, string>();
  private readonly subscribedThreads = new Set<string>();
  private readonly threadsById = new Map<string, CodexThread>();
  private readonly activeThreads = new Set<string>();
  private readonly reportedTurns = new Set<string>();
  private readonly logsByThread = new Map<string, string[]>();
  private readonly pendingStartPrompts = new Map<string, string>();
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private readyPromise?: Promise<void>;
  private readonly desktopScanner?: CodexDesktopSessionScanner;
  private desktopScannerStarted = false;

  constructor(
    private readonly options: {
      command: string;
      url: string;
      allowedRoots: string[];
      manageServer: boolean;
      reconnectMs: number;
      desktopHome?: string;
      desktopScanIntervalMs?: number;
      desktopReplayExisting?: boolean;
    },
    private readonly emit: (message: BridgeToControlMessage) => void,
  ) {
    if (options.desktopHome) {
      this.desktopScanner = new CodexDesktopSessionScanner({
        codexHome: options.desktopHome,
        allowedRoots: options.allowedRoots,
        intervalMs: options.desktopScanIntervalMs ?? 3_000,
        replayExisting: options.desktopReplayExisting ?? false,
        emit: (message) => {
          if (!("sessionId" in message) || !this.subscribedThreads.has(String(message.sessionId))) this.emit(message);
        },
      });
    }
  }

  start(): Promise<void> {
    this.stopping = false;
    if (this.desktopScanner && !this.desktopScannerStarted) {
      this.desktopScannerStarted = true;
      void this.desktopScanner.start().catch((error) => {
        this.desktopScannerStarted = false;
        log.error({ error }, "Unable to initialize Codex Desktop scanner");
      });
    }
    if (!this.readyPromise) {
      const attempt = this.startInternal();
      this.readyPromise = attempt;
      void attempt.catch((error) => {
        // A failed first connection used to leave readyPromise permanently
        // rejected while the Bridge process stayed alive. systemd therefore
        // saw a healthy process and never restarted it, even if App Server
        // became available later. Clear only the attempt that failed and keep
        // retrying inside the adapter.
        if (this.readyPromise === attempt) this.readyPromise = undefined;
        if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
          // Initialization can fail after the WebSocket opens (for example,
          // during initialize or thread restoration). Do not leave that
          // half-initialized connection alive beside the retry connection.
          this.socket.terminate();
        }
        log.error({ error }, "Unable to initialize Codex App Server connection");
        this.scheduleReconnect();
      });
    }
    return this.readyPromise;
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "bridge shutdown");
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.rejectPending(new Error("Codex App Server stopped"));
    this.pendingUserInput.clear();
    this.clearPendingApprovals();
    this.desktopScanner?.stop();
    this.desktopScannerStarted = false;
  }

  async startSession(requestId: string, projectPath: string, prompt?: string, resumeSessionId?: string): Promise<void> {
    await this.ensureReady();
    const cwd = await resolveProjectPath(projectPath, this.options.allowedRoots);
    if (prompt) this.pendingStartPrompts.set(cwd, prompt);
    try {
      if (resumeSessionId) {
        const thread = await this.ensureThreadSubscribed(resumeSessionId);
        const threadCwd = await resolveProjectPath(thread.cwd, this.options.allowedRoots);
        if (threadCwd !== cwd) throw new Error(`Codex thread ${resumeSessionId} belongs to ${threadCwd}, not ${cwd}`);
        await this.discoverThread(thread, prompt, requestId);
        if (prompt) await this.startTurn(thread.id, prompt);
        return;
      }
      const result = await this.request<{ thread: CodexThread }>("thread/start", { cwd });
      this.subscribedThreads.add(result.thread.id);
      await this.discoverThread(result.thread, prompt, requestId);
      if (prompt) await this.startTurn(result.thread.id, prompt);
    } finally {
      if (prompt && this.pendingStartPrompts.get(cwd) === prompt) this.pendingStartPrompts.delete(cwd);
    }
  }

  async input(sessionId: string, text: string): Promise<void> {
    await this.ensureReady();
    const userInput = this.pendingUserInput.get(sessionId);
    if (userInput) {
      const answers = parseUserInputAnswers(text, userInput.questions);
      this.respond(userInput.requestId, { answers });
      this.pendingUserInput.delete(sessionId);
      this.appendLog(sessionId, "User input answered from Matrix");
      return;
    }
    let desktopCwd: string | undefined;
    if (!this.subscribedThreads.has(sessionId) && this.desktopScanner) {
      await this.desktopScanner.refresh();
      if (this.desktopScanner.isThreadActive(sessionId)) {
        throw new Error("Codex Desktop is still running this session; wait for the current turn to finish before continuing from Matrix");
      }
      desktopCwd = this.desktopScanner.getThreadCwd(sessionId);
    }
    await this.ensureThreadSubscribed(sessionId);
    const activeTurnId = this.activeTurns.get(sessionId);
    const input = [{ type: "text", text, text_elements: [] }];
    if (activeTurnId) {
      await this.request("turn/steer", { threadId: sessionId, expectedTurnId: activeTurnId, input });
    } else {
      await this.request("turn/start", {
        threadId: sessionId,
        input,
        ...(desktopCwd ? { cwd: desktopCwd } : {}),
      });
    }
  }

  async approve(sessionId: string, approvalId: string, choice: ApprovalChoice): Promise<void> {
    await this.ensureReady();
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.sessionId !== sessionId) throw new Error("This approval request is no longer pending");
    if (approval.answered) return;
    approval.answered = true;
    try {
      this.respond(approval.requestId, approvalResponseFor(approval.method, approval.params, choice));
      this.appendLog(sessionId, `Approval answered from Matrix: ${choice}`);
    } catch (error) {
      approval.answered = false;
      throw error;
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.ensureReady();
    const activeTurnId = this.activeTurns.get(sessionId);
    if (!activeTurnId) throw new Error(`Session ${sessionId} has no active turn`);
    await this.request("turn/interrupt", { threadId: sessionId, turnId: activeTurnId });
  }

  logs(sessionId: string, count: number): string {
    return this.logsByThread.get(sessionId)?.slice(-count).join("\n") || "No structured events captured yet.";
  }

  sessionActivity(): {
    activeSessionIds: string[];
    waitingSessionIds: string[];
    blockedSessionIds: string[];
  } {
    return {
      activeSessionIds: [...new Set([...this.activeThreads, ...this.activeTurns.keys()])],
      waitingSessionIds: [...this.pendingUserInput.keys()],
      blockedSessionIds: [...new Set([...this.pendingApprovals.values()].map((approval) => approval.sessionId))],
    };
  }

  private async startInternal(): Promise<void> {
    if (this.options.manageServer && !await this.serverReady()) this.spawnServer();
    if (this.options.manageServer) await this.waitForServer();
    await this.connect();
    await this.restoreLoadedThreads();
  }

  private async ensureReady(): Promise<void> {
    if (!this.readyPromise) await this.start();
    else await this.readyPromise;
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Codex App Server is not connected");
  }

  private spawnServer(): void {
    const child = spawn(this.options.command, ["app-server", "--listen", this.options.url], {
      env: this.options.desktopHome
        ? { ...process.env, CODEX_HOME: this.options.desktopHome }
        : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (data) => log.debug({ output: data.toString().trim() }, "App Server stdout"));
    child.stderr?.on("data", (data) => log.info({ output: data.toString().trim() }, "App Server stderr"));
    child.on("error", (error) => log.error({ error }, "Unable to start Codex App Server"));
    child.on("exit", (code, signal) => {
      log.warn({ code, signal }, "Codex App Server exited");
      this.child = undefined;
    });
  }

  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.serverReady()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Codex App Server did not become ready: ${this.options.url}`);
  }

  private async serverReady(): Promise<boolean> {
    try {
      const url = new URL(this.options.url);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "/readyz";
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("App Server WebSocket connection timeout")), 10_000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    socket.on("message", (data) => void this.handleMessage(data.toString()));
    socket.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    socket.on("error", (error) => log.warn({ error }, "App Server WebSocket error"));
    await this.request("initialize", {
      clientInfo: { name: "agent_bridge", title: "Agent Bridge", version: "0.2.0" },
    });
    this.notify("initialized", {});
    log.info({ url: this.options.url }, "Connected to Codex App Server");
  }

  private async restoreLoadedThreads(): Promise<void> {
    const result = await this.request<{ data: string[] }>("thread/loaded/list", { limit: 100 });
    for (const threadId of result.data) {
      try {
        await this.ensureThreadSubscribed(threadId);
      } catch (error) {
        log.warn({ error, threadId }, "Unable to restore loaded Codex thread");
      }
    }
  }

  private async ensureThreadSubscribed(threadId: string): Promise<CodexThread> {
    const known = this.threadsById.get(threadId);
    if (this.subscribedThreads.has(threadId) && known) return known;
    const resumed = await this.request<{ thread: CodexThread }>("thread/resume", { threadId });
    this.subscribedThreads.add(threadId);
    await this.discoverThread(resumed.thread);
    return resumed.thread;
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      log.warn({ raw: raw.slice(0, 500) }, "Invalid App Server JSON");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? `App Server error ${message.error.code ?? ""}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) await this.handleNotification(message.method, message.params ?? {});
  }

  private handleServerRequest(message: RpcMessage): void {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions as UserInputQuestion[] : [];
      if (!questions.length) {
        this.respond(message.id!, { answers: {} });
        return;
      }
      this.pendingUserInput.set(threadId, { requestId: message.id!, questions });
      const summary = formatUserInputRequest(questions);
      this.appendLog(threadId, summary);
      this.emit({ type: "agent.waiting", sessionId: threadId, timestamp: Date.now(), summary });
      return;
    }
    const kind = approvalKind(message.method ?? "");
    if (kind) {
      const approvalId = randomUUID();
      const summary = approvalSummary(message.method!, params);
      this.pendingApprovals.set(approvalId, {
        requestId: message.id!,
        sessionId: threadId,
        method: message.method!,
        params,
        answered: false,
      });
      this.appendLog(threadId, summary);
      this.emit({
        type: "approval_request",
        sessionId: threadId,
        approvalId,
        kind,
        summary,
        choices: approvalChoicesFor(message.method!, params),
      });
      return;
    }
    const summary = approvalSummary(message.method ?? "approval", params);
    this.appendLog(threadId, summary);
    this.emit({ type: "agent.blocked", sessionId: threadId, timestamp: Date.now(), summary });
    // The local TUI remains the approval reviewer. This observer intentionally does not answer.
  }

  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "thread/started") {
      const thread = params.thread as CodexThread | undefined;
      if (thread) {
        this.subscribedThreads.add(thread.id);
        await this.discoverThread(thread, this.pendingStartPrompts.get(thread.cwd));
      }
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    if (method === "serverRequest/resolved") {
      const requestId = typeof params.requestId === "string" || typeof params.requestId === "number"
        ? params.requestId
        : undefined;
      const pending = this.pendingUserInput.get(threadId);
      if (pending && (requestId === undefined || pending.requestId === requestId)) {
        this.pendingUserInput.delete(threadId);
      }
      for (const [approvalId, approval] of this.pendingApprovals) {
        if (approval.sessionId === threadId && (requestId === undefined || approval.requestId === requestId)) {
          this.pendingApprovals.delete(approvalId);
          this.emit({ type: "approval_resolved", sessionId: threadId, approvalId });
        }
      }
      return;
    }
    if (method === "thread/status/changed") {
      const status = params.status as CodexThread["status"] | undefined;
      if (status?.type === "active") {
        if (!this.activeThreads.has(threadId)) {
          this.activeThreads.add(threadId);
          this.appendLog(threadId, "Turn started");
          this.emit({ type: "agent.started", sessionId: threadId, timestamp: Date.now(), summary: "New turn started" });
        }
      } else if (status?.type === "idle") {
        const wasActive = this.activeThreads.delete(threadId);
        if (wasActive) await this.syncLatestCompletedTurn(threadId);
      } else if (status?.type === "systemError") {
        this.activeThreads.delete(threadId);
        this.emit({ type: "agent.failed", sessionId: threadId, timestamp: Date.now(), summary: "Codex App Server reported a thread error" });
      }
      return;
    }
    if (method === "turn/started") {
      const turn = params.turn as CodexTurn;
      if (turn?.id) this.activeTurns.set(threadId, turn.id);
      if (!this.activeThreads.has(threadId)) {
        this.activeThreads.add(threadId);
        this.appendLog(threadId, "Turn started");
        this.emit({ type: "agent.started", sessionId: threadId, timestamp: Date.now(), summary: "New turn started" });
      }
      return;
    }
    if (method === "item/completed") {
      const item = params.item as ThreadItem | undefined;
      if (item) this.handleCompletedItem(threadId, item);
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as CodexTurn;
      this.activeTurns.delete(threadId);
      this.activeThreads.delete(threadId);
      if (!turn?.id || this.reportedTurns.has(turn.id)) return;
      this.reportedTurns.add(turn.id);
      this.emitTerminalTurn(threadId, turn);
    }
  }

  private async syncLatestCompletedTurn(threadId: string): Promise<void> {
    try {
      const result = await this.request<{ thread: CodexThread & { turns?: CodexTurn[] } }>("thread/read", {
        threadId,
        includeTurns: true,
      });
      // Only inspect the newest turn. Walking backwards into any older
      // unreported turn can replay stale output when this read races with the
      // real-time turn/completed notification for the current turn.
      const turns = result.thread.turns ?? [];
      const turn = turns.at(-1);
      if (!turn || turn.status === "inProgress" || this.reportedTurns.has(turn.id)) return;
      this.reportedTurns.add(turn.id);
      for (const item of turn.items ?? []) this.handleCompletedItem(threadId, item);
      this.emitTerminalTurn(threadId, turn);
    } catch (error) {
      log.warn({ error, threadId }, "Unable to read completed Codex turn");
    }
  }

  private emitTerminalTurn(threadId: string, turn: CodexTurn): void {
    const eventId = `app-server:${threadId}:${turn.id}:terminal`;
    const summary = finalAgentText(turn.items ?? []);
    if (turn.status === "failed") {
      this.emit({
        type: "agent.failed", eventId, sessionId: threadId, timestamp: Date.now(),
        durationMs: turn.durationMs ?? undefined, summary: turn.error?.message ?? summary,
      });
    } else if (turn.status === "interrupted") {
      this.emit({
        type: "agent.stopped", eventId, sessionId: threadId, timestamp: Date.now(),
        durationMs: turn.durationMs ?? undefined,
      });
    } else {
      this.emit({
        type: "agent.completed", eventId, sessionId: threadId, timestamp: Date.now(),
        durationMs: turn.durationMs ?? undefined, summary,
      });
    }
  }

  private async discoverThread(thread: CodexThread, initialPrompt?: string, requestId?: string): Promise<void> {
    if (!thread.id || !thread.cwd || thread.parentThreadId) return;
    let projectPath: string;
    try {
      projectPath = await resolveProjectPath(thread.cwd, this.options.allowedRoots);
    } catch {
      return;
    }
    this.threadsById.set(thread.id, thread);
    const message: SessionDiscoveredMessage = {
      type: "session.discovered",
      requestId,
      sessionId: thread.id,
      nativeSessionId: thread.id,
      agentType: "codex-cli",
      projectPath,
      projectName: basename(projectPath),
      title: thread.name || undefined,
      promptSummary: summarizePrompt(initialPrompt || thread.preview),
      status: thread.status?.type === "active" ? "working" : "waiting",
      createdAt: (thread.createdAt ?? Math.floor(Date.now() / 1000)) * 1000,
    };
    this.emit(message);
  }

  private handleCompletedItem(threadId: string, item: ThreadItem): void {
    if (item.type === "agentMessage" && item.text) {
      this.appendLog(threadId, item.text);
      this.emit({ type: "agent.output", sessionId: threadId, timestamp: Date.now(), text: item.text });
    } else if (item.type === "commandExecution") {
      const summary = `$ ${item.command ?? "command"}${item.exitCode !== null && item.exitCode !== undefined ? `\nExit: ${item.exitCode}` : ""}`;
      this.appendLog(threadId, `${summary}${item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ""}`);
      if (item.status === "failed" || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0)) {
        this.emit({ type: "agent.progress", sessionId: threadId, timestamp: Date.now(), summary });
      }
    } else if (item.type === "fileChange") {
      const count = item.changes?.length ?? 0;
      const summary = `${count} file change${count === 1 ? "" : "s"} applied`;
      this.appendLog(threadId, summary);
      this.emit({ type: "agent.progress", sessionId: threadId, timestamp: Date.now(), summary });
    }
  }

  private async startTurn(threadId: string, text: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  private request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("App Server is not connected"));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ method, id, params }));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ method, params }));
  }

  private respond(id: number | string, result: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Codex App Server is not connected");
    this.socket.send(JSON.stringify({ id, result }));
  }

  private handleClose(code: number, reason: string): void {
    log.warn({ code, reason }, "Disconnected from Codex App Server");
    this.rejectPending(new Error("Codex App Server disconnected"));
    this.socket = undefined;
    this.pendingUserInput.clear();
    this.clearPendingApprovals();
    this.subscribedThreads.clear();
    this.activeThreads.clear();
    this.readyPromise = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch((error) => {
        // start() schedules the next bounded attempt after clearing the
        // rejected promise. This catch prevents an unhandled rejection while
        // preserving the retry loop.
        log.error({ error }, "Unable to reconnect to Codex App Server");
      });
    }, this.options.reconnectMs);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private appendLog(threadId: string, text: string): void {
    const lines = this.logsByThread.get(threadId) ?? [];
    lines.push(...text.split("\n"));
    if (lines.length > 2_000) lines.splice(0, lines.length - 2_000);
    this.logsByThread.set(threadId, lines);
  }

  private clearPendingApprovals(): void {
    for (const [approvalId, approval] of this.pendingApprovals) {
      this.emit({ type: "approval_resolved", sessionId: approval.sessionId, approvalId });
    }
    this.pendingApprovals.clear();
  }

}

export function summarizePrompt(prompt: string | undefined, limit = 240): string | undefined {
  const summary = prompt?.replace(/\s+/g, " ").trim();
  if (!summary) return undefined;
  return summary.length <= limit ? summary : `${summary.slice(0, limit - 1)}…`;
}

type DirectoryQuery = (query: string) => Promise<string>;

async function queryZoxide(query: string): Promise<string> {
  const { stdout } = await execFileAsync("zoxide", ["query", "--", query], { encoding: "utf8" });
  return stdout.trim();
}

export async function resolveProjectPath(
  input: string,
  allowedRoots: string[],
  directoryQuery: DirectoryQuery = queryZoxide,
): Promise<string> {
  let candidate = input;
  if (!isAbsolute(candidate)) {
    const query = candidate.startsWith("z:") ? candidate.slice(2) : candidate;
    if (!query) throw new Error("Fuzzy project path cannot be empty");
    try {
      candidate = (await directoryQuery(query)).trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to resolve project path "${input}" with zoxide: ${detail}`);
    }
    if (!candidate) throw new Error(`No zoxide match found for project path: ${input}`);
  }

  if (!isAbsolute(candidate) || !existsSync(candidate)) throw new Error(`Invalid project path: ${candidate}`);
  const path = realpathSync(candidate);
  const allowed = allowedRoots.some((root) => {
    if (!isAbsolute(root) || !existsSync(root)) return false;
    const relation = relative(realpathSync(root), path);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
  });
  if (!allowed) throw new Error(`Project path is outside BRIDGE_ALLOWED_ROOTS: ${path}`);
  return resolve(path);
}

function approvalKind(method: string): ApprovalKind | undefined {
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "file-change";
  if (method === "item/permissions/requestApproval") return "permissions";
  return undefined;
}

export function approvalResponseFor(
  method: string,
  params: Record<string, unknown>,
  choice: ApprovalChoice,
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: choice === "deny" ? {} : (params.permissions ?? {}),
      scope: choice === "allow-session" ? "session" : "turn",
    };
  }
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  const named = (name: string): unknown | undefined => available?.find((decision) =>
    decision === name || (typeof decision === "object" && decision !== null && name in decision));
  const decision = choice === "allow"
    ? (named("accept") ?? (!available ? "accept" : undefined))
    : choice === "deny"
      ? (named("decline") ?? named("cancel") ?? (!available ? "decline" : undefined))
      : (named("acceptForSession")
        ?? named("acceptWithExecpolicyAmendment")
        ?? named("applyNetworkPolicyAmendment")
        ?? (!available ? "acceptForSession" : undefined));
  if (decision === undefined) throw new Error(`Approval choice ${choice} is not available for this request`);
  return { decision };
}

export function approvalChoicesFor(method: string, params: Record<string, unknown>): ApprovalChoice[] {
  if (method === "item/permissions/requestApproval") return ["allow", "deny", "allow-session"];
  const choices: ApprovalChoice[] = [];
  for (const choice of ["allow", "deny", "allow-session"] as const) {
    try {
      approvalResponseFor(method, params, choice);
      choices.push(choice);
    } catch {
      // App Server explicitly omitted every compatible decision for this choice.
    }
  }
  return choices;
}

export function approvalSummary(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval") {
    const network = params.networkApprovalContext as { host?: unknown; protocol?: unknown } | undefined;
    const target = network && typeof network.host === "string"
      ? `${typeof network.protocol === "string" ? `${network.protocol}://` : ""}${network.host}`
      : undefined;
    return `Command approval required${target ? `\nNetwork: ${target}` : ""}${typeof params.command === "string" ? `\nCommand: ${params.command}` : ""}${typeof params.cwd === "string" ? `\nDirectory: ${params.cwd}` : ""}${typeof params.reason === "string" ? `\nReason: ${params.reason}` : ""}`;
  }
  if (method === "item/fileChange/requestApproval") return `File change approval required${typeof params.grantRoot === "string" ? `\nPath: ${params.grantRoot}` : ""}${typeof params.reason === "string" ? `\nReason: ${params.reason}` : ""}`;
  if (method === "item/permissions/requestApproval") return `Permission approval required${typeof params.cwd === "string" ? `\nDirectory: ${params.cwd}` : ""}${typeof params.reason === "string" ? `\nReason: ${params.reason}` : ""}`;
  return `Codex requires attention: ${method}`;
}

export function formatUserInputRequest(questions: UserInputQuestion[]): string {
  const lines = questions.flatMap((question, index) => {
    const title = questions.length > 1 ? `${index + 1}. ${question.header}` : question.header;
    const options = question.options?.map((option, optionIndex) =>
      `   ${optionIndex + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`) ?? [];
    return [`${title}: ${question.question}`, ...options];
  });
  const instruction = questions.length === 1
    ? "Reply in this thread with your answer. You may use an option number or label."
    : `Reply with ${questions.length} answers, one per line in the same order. Option numbers or labels are accepted.`;
  return `${lines.join("\n")}\n\n${instruction}`;
}

export function parseUserInputAnswers(
  text: string,
  questions: UserInputQuestion[],
): Record<string, { answers: string[] }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("User input answer cannot be empty");
  const values = questions.length === 1
    ? [trimmed]
    : trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (values.length !== questions.length) {
    throw new Error(`Expected ${questions.length} answers, one per line, but received ${values.length}`);
  }
  return Object.fromEntries(questions.map((question, index) => [
    question.id,
    { answers: [normalizeUserInputAnswer(values[index]!, question)] },
  ]));
}

function normalizeUserInputAnswer(value: string, question: UserInputQuestion): string {
  const withoutPrefix = value.replace(/^\s*\d+[.)]\s*/, "").trim();
  const options = question.options ?? [];
  if (!options.length) return withoutPrefix;
  const numeric = Number(withoutPrefix);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return options[numeric - 1]!.label;
  const option = options.find((candidate) => candidate.label.toLocaleLowerCase() === withoutPrefix.toLocaleLowerCase());
  if (option) return option.label;
  if (question.isOther) return withoutPrefix;
  throw new Error(`Invalid answer for ${question.header}: use an option number or label`);
}

function finalAgentText(items: ThreadItem[]): string | undefined {
  return [...items].reverse().find((item) => item.type === "agentMessage" && item.text)?.text;
}
