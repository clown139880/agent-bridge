import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { AgentControlStore, Store, type SessionRecord, type WorkerRunRecord } from "@agent-bridge/database";
import {
  parseMessage,
  statusForEvent,
  type AgentEvent,
  type ApprovalChoice,
  type ApprovalRequestMessage,
  type BridgeToControlMessage,
  type ControlToBridgeMessage,
  type RegisterMessage,
  type SessionDiscoveredMessage,
  type SessionActivityStatus,
  type SessionState,
} from "@agent-bridge/protocol";
import type { ControlGateway } from "./matrix.js";
import { AgentControlApi } from "./api/router.js";
import { BridgeRegistry, type BridgeConnection } from "./bridge-registry.js";

const log = pino({ name: "control-plane" });

interface PendingRunLaunch {
  runId: string;
  machineId: string;
  projectPath: string;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  targetVersion: string;
  epoch: string;
  timeout: NodeJS.Timeout;
}

interface PendingLaunch {
  sender: string;
  prompt: string;
  sourceEventId: string;
  machineId?: string;
  agentType: "codex-cli";
}

interface PendingLaunchSelection {
  launch: PendingLaunch;
  messageEventId: string;
  reactionEventIds: string[];
  choices: Map<string, { machineId?: string; projectPath?: string; manualPath?: boolean }>;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  machineId: string;
  threadId?: string;
  messageEventId?: string;
  reactionEventIds: string[];
  choices: ApprovalChoice[];
  kind: ApprovalRequestMessage["kind"];
  summary: string;
}

const APPROVAL_REACTIONS: ReadonlyArray<{ key: string; choice: ApprovalChoice; label: string }> = [
  { key: "✅", choice: "allow", label: "允许一次" },
  { key: "❌", choice: "deny", label: "拒绝" },
  { key: "♾️", choice: "allow-session", label: "本 Session 一直允许" },
];

const NUMBER_REACTIONS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"] as const;
const RECLAIMABLE_BLOCKED_AGE_MS = 300_000;
const RECLAIM_REASON = "Reclaimed stale reasonless blocked run; bridge reported no actionable approval";

export class ControlPlane {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly registry = new BridgeRegistry();
  private readonly bridges = this.registry.connections;
  private readonly controlStore: AgentControlStore;
  private readonly controlApi: AgentControlApi;
  private readonly approvalsByEvent = new Map<string, PendingApproval>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly resolvedApprovalIds = new Set<string>();
  private readonly progressNotifiedSessions = new Set<string>();
  private readonly launchSelectionsByEvent = new Map<string, PendingLaunchSelection>();
  private readonly launchSelectionsBySender = new Map<string, PendingLaunchSelection>();
  private readonly launchesAwaitingPath = new Map<string, PendingLaunch>();
  private readonly launchesByRequestId = new Map<string, PendingLaunch & { machineId: string; projectPath: string }>();
  private readonly updateNotifications = new Set<string>();
  private readonly pendingRunLaunches = new Map<string, PendingRunLaunch>();
  private roomId = "";
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly matrix: ControlGateway,
    private readonly options: {
      host: string;
      port: number;
      bridgeToken?: string;
      workerApiEnabled?: boolean;
      workerApiToken?: string;
      controlApiReadToken?: string;
      controlApiWriteToken?: string;
      retention?: { sessionEventsMs: number; streamEventsMs: number; actionsMs: number };
      sse?: { keepaliveMs: number; pollMs: number; maxBackpressure: number; actionTimeoutMs?: number };
      bridgeUpdate?: {
        latestVersion: string;
        source: string;
        publishedAt?: number;
        admissionTimeoutMs?: number;
      };
    },
  ) {
    this.controlStore = new AgentControlStore(store.db, options.retention ?? {
      sessionEventsMs: 30 * 86_400_000, streamEventsMs: 7 * 86_400_000, actionsMs: 86_400_000,
    });
    this.controlApi = new AgentControlApi(store, this.controlStore, this.registry, {
      workerToken: options.workerApiToken, readToken: options.controlApiReadToken,
      writeToken: options.controlApiWriteToken, sseKeepaliveMs: options.sse?.keepaliveMs ?? 15_000,
      ssePollMs: options.sse?.pollMs ?? 250, sseMaxBackpressure: options.sse?.maxBackpressure ?? 3,
      actionTimeoutMs: options.sse?.actionTimeoutMs ?? 30_000,
    });
    this.http = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, bridges: this.bridges.size, roomId: this.roomId }));
        return;
      }
      if (request.url?.startsWith("/api/v1/")) {
        if (!this.options.workerApiEnabled && !this.options.controlApiReadToken && !this.options.controlApiWriteToken) {
          response.writeHead(404).end();
          return;
        }
        const apiPath = new URL(request.url, "http://localhost").pathname;
        const legacyRoute = (request.method === "POST" && apiPath === "/api/v1/runs")
          || /^\/api\/v1\/runs\/[^/]+(?:\/.*)?$/.test(apiPath);
        void (legacyRoute ? this.handleWorkerApi(request, response)
          : this.controlApi.handle(request, response).then((handled) => handled
            ? undefined : this.handleWorkerApi(request, response))).catch((error) => {
          log.error({ error }, "Worker API request failed");
          if (!response.headersSent) this.json(response, 500, { error: "internal_error" });
          else response.end();
        });
        return;
      }
      response.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    this.roomId = await this.matrix.start();
    await new Promise<void>((resolve) => this.http.listen(this.options.port, this.options.host, resolve));
    setInterval(() => this.store.markStaleMachinesOffline(Date.now() - 45_000), 15_000).unref();
    this.controlStore.cleanup();
    this.cleanupTimer = setInterval(() => this.controlStore.cleanup(), 60 * 60_000);
    this.cleanupTimer.unref();
    log.info({ host: this.options.host, port: this.options.port, roomId: this.roomId }, "Control plane listening");
  }

  async stop(): Promise<void> {
    this.matrix.stop();
    clearInterval(this.cleanupTimer);
    for (const bridge of this.bridges.values()) bridge.socket.close(1001, "server shutdown");
    for (const launch of this.pendingRunLaunches.values()) clearTimeout(launch.timeout);
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  async onRoomMessage(body: string, sender = "", eventId = ""): Promise<void> {
    const input = body.trim();
    if (input === "!help" || input === "/help") {
      await this.matrix.sendNotice([
        "Agent Control commands:",
        "直接在频道发送任务即可开始；按表情选择 agent@机器 和工作目录。",
        "选择“其他目录”后，发送绝对路径或 zoxide 查询（例如 z:agent-bridge）。",
        "!codex / !codex@machine 仍保留兼容。",
        "!machines",
        "!sessions",
        "Inside a session thread: send text, /log [N], or /stop",
      ].join("\n"));
      return;
    }
    if (input === "!machines") {
      const machines = this.store.listMachines();
      await this.matrix.sendNotice(machines.length
        ? machines.map((item) => `${item.status === "online" ? "🟢" : "⚫"} ${item.id} · ${item.platform} · ${item.hostname}`).join("\n")
        : "No bridges have registered yet.");
      return;
    }
    if (input === "!sessions") {
      const sessions = this.store.listSessions();
      await this.matrix.sendNotice(sessions.length
        ? sessions.map((item) => `${statusIcon(item.status)} ${item.projectName} · ${item.status} · ${item.machineId}`).join("\n")
        : "No sessions yet.");
      return;
    }
    if (input === "!cancel" && sender) {
      await this.cancelLaunch(sender);
      await this.matrix.sendNotice("已取消启动。", { kind: "launch.cancelled" });
      return;
    }
    const match = input.match(/^!codex(?:@([^\s]+))?\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (match) {
      await this.createCodexSession(match[1], match[2], match[3]);
      return;
    }
    if (input.startsWith("!")) {
      await this.matrix.sendNotice("Unknown command. Send !help for usage.");
      return;
    }
    if (!input || !sender || !eventId) return;
    const awaitingPath = this.launchesAwaitingPath.get(sender);
    if (awaitingPath) {
      this.launchesAwaitingPath.delete(sender);
      await this.startLaunch(awaitingPath, input);
      return;
    }
    if (this.launchSelectionsBySender.has(sender)) {
      await this.matrix.sendNotice("请先点击上一条选择消息下的表情，或发送 !cancel。", { kind: "launch.reminder" });
      return;
    }
    await this.beginLaunch({ sender, prompt: body, sourceEventId: eventId, agentType: "codex-cli" });
  }

  async onThreadMessage(roomId: string, threadId: string, body: string): Promise<void> {
    const session = this.store.getSessionByThread(roomId, threadId);
    if (!session) return;
    const bridge = this.bridges.get(session.machineId);
    if (!bridge) {
      await this.matrix.sendThread(threadId, `🔴 Bridge ${session.machineId} is offline.`);
      return;
    }
    const command = body.trim();
    if (command === "/stop") {
      this.send(bridge.socket, { type: "stop_agent", sessionId: session.id });
    } else if (command.startsWith("/log")) {
      const lines = Math.min(500, Math.max(1, Number(command.split(/\s+/)[1] ?? "100") || 100));
      this.send(bridge.socket, { type: "log_request", sessionId: session.id, lines });
    } else {
      this.send(bridge.socket, { type: "agent_input", sessionId: session.id, text: body });
      await this.matrix.sendThread(threadId, "📨 Sent to Codex.");
    }
  }

  async onReaction(targetEventId: string, key: string, sender = ""): Promise<void> {
    const launchSelection = this.launchSelectionsByEvent.get(targetEventId);
    const launchChoice = launchSelection?.choices.get(key);
    if (launchSelection && launchChoice && (!sender || launchSelection.launch.sender === sender)) {
      await this.resolveLaunchSelection(launchSelection, launchChoice);
      return;
    }
    const pending = this.approvalsByEvent.get(targetEventId);
    const action = APPROVAL_REACTIONS.find((candidate) => candidate.key === key);
    if (!pending || !action || !pending.choices.includes(action.choice)) return;
    this.forgetApproval(pending);
    await this.removeApprovalReactions(pending);
    const bridge = this.bridges.get(pending.machineId);
    if (!bridge) {
      if (pending.threadId) await this.matrix.sendThread(pending.threadId, `🔴 Bridge ${pending.machineId} is offline; the approval could not be submitted.`);
      return;
    }
    const projected=this.controlStore.pending(pending.approvalId);
    if(projected&&!this.controlStore.reservePending(pending.approvalId,`matrix:${targetEventId}`)) {
      if(pending.threadId)await this.matrix.sendThread(pending.threadId,"ℹ️ This approval was already handled by another client.");
      return;
    }
    this.send(bridge.socket, {
      type: "approval_response",
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      choice: action.choice,
    });
    this.controlStore.resolvePending(pending.approvalId,
      action.choice === "deny" ? "denied" : "accepted", { choice: action.choice });
    this.store.updateSessionStatus(pending.sessionId, "working");
    const workerRun = this.store.getWorkerRunBySession(pending.sessionId);
    if (workerRun) this.store.updateWorkerRun(workerRun.id, "working");
    if (pending.threadId) await this.matrix.sendThread(pending.threadId, `🔐 已选择：${action.label}。Codex 正在继续。`);
  }

  private bearerMatch(header: string | undefined, token: string | undefined): boolean {
    if (!header || !token) return false;
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    const a = Buffer.from(header.slice(prefix.length));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handleWorkerApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization;
    const allowed = this.bearerMatch(authorization, this.options.workerApiToken)
      || this.bearerMatch(authorization, this.options.controlApiWriteToken)
      || (request.method === "GET" && this.bearerMatch(authorization, this.options.controlApiReadToken));
    if (!allowed) {
      this.json(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/v1/workers") {
      const workers = this.store.listMachines().map((machine) => ({
        id: `codex@${machine.id}`,
        machineId: machine.id,
        name: `Codex @ ${machine.name}`,
        status: this.bridges.has(machine.id) ? "online" : "offline",
        platform: machine.platform,
        hostname: machine.hostname,
        capabilities: machine.capabilities,
        workspaces: this.store.listProjectPaths(machine.id),
        lastSeenAt: machine.lastSeenAt,
      }));
      this.json(response, 200, { workers });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/runs") {
      const body = await readJson(request);
      const workerId = optionalStringField(body, "workerId");
      const explicitMachineId = optionalStringField(body, "machineId");
      const machineId = workerId?.startsWith("codex@") ? workerId.slice("codex@".length) : explicitMachineId;
      const projectPath = stringField(body, "projectPath");
      const prompt = stringField(body, "prompt");
      const requestedRunId = optionalStringField(body, "runId");
      const taskId = optionalStringField(body, "taskId");
      const conversationId = optionalStringField(body, "conversationId");
      const resumeSessionId = optionalStringField(body, "resumeSessionId");
      const model = optionalStringField(body, "model");
      const allowStaleVersion = body && typeof body === "object"
        ? (body as Record<string, unknown>).allow_stale_version === true : false;
      if (workerId && (!workerId.startsWith("codex@") || !machineId || (explicitMachineId && explicitMachineId !== machineId))) {
        this.json(response, 400, { error: "invalid_worker_id", workerId });
        return;
      }
      if (!machineId || !projectPath || !prompt) {
        this.json(response, 400, { error: "workerId, projectPath and prompt are required" });
        return;
      }
      const bridge = this.bridges.get(machineId);
      if (!bridge || !bridge.capabilities.includes("codex-cli")) {
        this.json(response, 409, { error: "worker_offline", machineId });
        return;
      }
      const runId = requestedRunId ?? randomUUID();
      const existing = this.store.getWorkerRun(runId);
      if (existing) {
        if (existing.machineId !== machineId || existing.projectPath !== projectPath
          || existing.taskId !== (taskId ?? null) || existing.conversationId !== (conversationId ?? null)) {
          this.json(response, 409, { error: "run_id_conflict", runId });
          return;
        }
        this.json(response, 200, workerRunJson(existing));
        return;
      }
      const priorConversationRun = !resumeSessionId && conversationId
        ? this.store.getLatestWorkerRunByConversation(conversationId, machineId, projectPath)
        : undefined;
      const priorTaskRun = !resumeSessionId && !priorConversationRun && taskId
        && conversationId?.startsWith("hermes-task:") && conversationId.endsWith(`:${taskId}`)
        ? this.store.getLatestLegacyWorkerRunByTask(taskId, machineId, projectPath)
        : undefined;
      const effectiveResumeSessionId = resumeSessionId
        ?? priorConversationRun?.sessionId ?? priorTaskRun?.sessionId ?? undefined;
      let resumeSession: SessionRecord | undefined;
      if (effectiveResumeSessionId) {
        resumeSession = this.store.getSession(effectiveResumeSessionId);
        if (!resumeSession) {
          this.json(response, 404, { error: "resume_session_not_found", resumeSessionId: effectiveResumeSessionId });
          return;
        }
        if (resumeSession.machineId !== machineId || resumeSession.projectPath !== projectPath) {
          this.json(response, 409, { error: "resume_session_conflict", resumeSessionId: effectiveResumeSessionId });
          return;
        }
        const latestSessionRun = this.store.getWorkerRunBySession(resumeSession.id);
        const runIsBusy = latestSessionRun
          ? ["starting", "working", "waiting", "blocked"].includes(latestSessionRun.status)
          : ["starting", "working", "blocked"].includes(resumeSession.status);
        if (runIsBusy) {
          this.json(response, 409, { error: "resume_session_busy", resumeSessionId: effectiveResumeSessionId });
          return;
        }
      }
      const now = Date.now();
      this.store.createWorkerRun({
        id: runId, taskId: taskId ?? null, conversationId: conversationId ?? null,
        machineId, agentType: "codex-cli", projectPath,
        sessionId: resumeSession?.id ?? null,
        status: this.bridgeNeedsUpdate(bridge) && !allowStaleVersion ? "update_waiting" : "starting",
        error: null, createdAt: now, updatedAt: now,
      });
      if (this.bridgeNeedsUpdate(bridge) && !allowStaleVersion) {
        this.queueRunForUpdate({ runId, machineId, projectPath, prompt,
          resumeSessionId: effectiveResumeSessionId, model });
        this.sendUpdateAnnouncement(bridge.socket);
      } else {
        if (allowStaleVersion && this.bridgeNeedsUpdate(bridge)) {
          log.warn({ machineId, runId, currentVersion: bridge.bridgeVersion,
            targetVersion: this.options.bridgeUpdate?.latestVersion }, "Audited stale bridge version override");
        }
        this.sendStartAgent(bridge, runId, projectPath, prompt, effectiveResumeSessionId, model);
      }
      this.json(response, 202, workerRunJson(this.store.getWorkerRun(runId)!));
      return;
    }
    const match = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)(?:\/(events|input|interrupt|reclaim))?$/);
    if (match) {
      const runId = decodeURIComponent(match[1]!);
      const action = match[2];
      const run = this.store.getWorkerRun(runId);
      if (!run) {
        this.json(response, 404, { error: "run_not_found", runId });
        return;
      }
      if (request.method === "GET" && !action) {
        const approvals = [...this.approvalsById.values()]
          .filter((approval) => approval.sessionId === run.sessionId)
          .map(({ approvalId, kind, summary, choices }) => ({ approvalId, kind, summary, choices }));
        this.json(response, 200, { ...workerRunJson(run), approvals });
        return;
      }
      if (request.method === "GET" && action === "events") {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? "0") || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100));
        const events = run.sessionId ? this.store.listEvents(run.sessionId, after, limit, run.id) : [];
        this.json(response, 200, { runId, events, next: events.at(-1)?.sequence ?? after });
        return;
      }
      if (request.method === "POST" && (action === "input" || action === "interrupt")) {
        if (!run.sessionId) {
          this.json(response, 409, { error: "run_not_attached", runId });
          return;
        }
        const bridge = this.bridges.get(run.machineId);
        if (!bridge) {
          this.json(response, 409, { error: "worker_offline", machineId: run.machineId });
          return;
        }
        if (action === "input") {
          const body = await readJson(request);
          const input = stringField(body, "text");
          const model = optionalStringField(body, "model");
          if (!input) {
            this.json(response, 400, { error: "text is required" });
            return;
          }
          this.send(bridge.socket, { type: "agent_input", sessionId: run.sessionId, text: input, model });
        } else {
          this.send(bridge.socket, { type: "stop_agent", sessionId: run.sessionId });
        }
        this.json(response, 202, { runId, accepted: true });
        return;
      }
      if (request.method === "POST" && action === "reclaim") {
        const hasApproval = [...this.approvalsById.values()].some((approval) => approval.sessionId === run.sessionId);
        if (run.status !== "blocked" || run.error || hasApproval
          || run.updatedAt > Date.now() - RECLAIMABLE_BLOCKED_AGE_MS) {
          this.json(response, 409, { error: "run_not_reclaimable", runId });
          return;
        }
        if (run.sessionId) {
          this.store.updateSessionStatus(run.sessionId, "failed");
          const bridge = this.bridges.get(run.machineId);
          if (bridge) this.send(bridge.socket, { type: "stop_agent", sessionId: run.sessionId });
        }
        this.store.updateWorkerRun(run.id, "failed", RECLAIM_REASON);
        this.json(response, 200, workerRunJson(this.store.getWorkerRun(run.id)!));
        return;
      }
    }
    const approvalMatch = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const runId = decodeURIComponent(approvalMatch[1]!);
      const approvalId = decodeURIComponent(approvalMatch[2]!);
      const run = this.store.getWorkerRun(runId);
      const pending = this.approvalsById.get(approvalId);
      if (!run || !run.sessionId || !pending || pending.sessionId !== run.sessionId) {
        this.json(response, 404, { error: "approval_not_found" });
        return;
      }
      const body = await readJson(request);
      const choice = stringField(body, "choice") as ApprovalChoice | undefined;
      if (!choice || !pending.choices.includes(choice)) {
        this.json(response, 400, { error: "invalid_choice", choices: pending.choices });
        return;
      }
      const bridge = this.bridges.get(run.machineId);
      if (!bridge) {
        this.json(response, 409, { error: "worker_offline", machineId: run.machineId });
        return;
      }
      const projected=this.controlStore.pending(approvalId);
      if(projected&&!this.controlStore.reservePending(approvalId,`legacy:${runId}:${approvalId}`)) {
        this.json(response,409,{error:"approval_already_resolved",runId,approvalId});
        return;
      }
      this.forgetApproval(pending);
      await this.removeApprovalReactions(pending);
      this.send(bridge.socket, { type: "approval_response", sessionId: run.sessionId, approvalId, choice });
      this.controlStore.resolvePending(approvalId, choice === "deny" ? "denied" : "accepted", { choice });
      this.store.updateSessionStatus(run.sessionId, "working");
      this.store.updateWorkerRun(run.id, "working");
      this.json(response, 202, { runId, approvalId, accepted: true });
      return;
    }
    this.json(response, 404, { error: "not_found" });
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url !== "/bridge") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws));
  }

  private handleConnection(socket: WebSocket): void {
    let machineId: string | undefined;
    let messageChain = Promise.resolve();
    const registrationTimeout = setTimeout(() => socket.close(1008, "registration timeout"), 10_000);
    socket.on("message", (data) => {
      const parsed = parseMessage(data.toString());
      if (!parsed) return this.send(socket, { type: "error", message: "Invalid JSON message" });
      if (!machineId) {
        if (parsed.type !== "register") return socket.close(1008, "register first");
        const message = parsed as unknown as RegisterMessage;
        if (this.options.bridgeToken && message.token !== this.options.bridgeToken) return socket.close(1008, "invalid token");
        if (!message.machineId || !message.hostname || !Array.isArray(message.capabilities)) return socket.close(1008, "invalid registration");
        const registeredId = message.machineId;
        machineId = registeredId;
        clearTimeout(registrationTimeout);
        this.bridges.get(registeredId)?.socket.close(1000, "replaced");
        this.bridges.set(registeredId, {
          machineId: registeredId,
          name: message.name || registeredId,
          capabilities: message.capabilities,
          features: message.features,
          protocolVersion: message.protocolVersion,
          bridgeVersion: message.bridgeVersion,
          socket,
        });
        this.store.upsertMachine({
          id: registeredId, name: message.name || registeredId, platform: message.platform,
          hostname: message.hostname, capabilities: message.capabilities,
        });
        this.controlStore.updateMachineConnection(registeredId, message.bridgeVersion,
          message.protocolVersion, message.features);
        this.send(socket, { type: "registered", machineId: registeredId });
        this.sendUpdateAnnouncement(socket);
        this.releasePendingRuns(registeredId);
        this.replayControlActions(registeredId);
        log.info({ machineId: registeredId }, "Bridge registered");
        return;
      }
      const registeredMachineId = machineId;
      messageChain = messageChain
        .then(() => this.handleBridgeMessage(registeredMachineId, parsed as unknown as BridgeToControlMessage))
        .catch((error) => log.error({ error, machineId: registeredMachineId }, "Unable to handle Bridge message"));
    });
    socket.on("close", () => {
      clearTimeout(registrationTimeout);
      if (machineId && this.registry.remove(machineId, socket)) {
        try { this.controlStore.markMachineOffline(machineId); }
        catch (error) { log.debug({ error, machineId }, "Unable to persist bridge disconnect during shutdown"); }
      }
    });
    socket.on("error", (error) => log.warn({ error, machineId }, "Bridge socket error"));
  }

  private async handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void> {
    if (message.type === "state.snapshot") {
      for (const session of message.sessions) this.controlStore.upsertSession(machineId, session);
      for (const approval of message.approvals) await this.handleApprovalRequest(machineId,
        { type: "approval_request", ...approval });
      for (const input of message.userInputs) this.controlStore.upsertUserInput(machineId, input);
      if (message.complete) {
        const pendingIds = new Set([...message.approvals.map((item) => item.approvalId),
          ...message.userInputs.map((item) => item.requestId)]);
        const rows = this.store.db.prepare("SELECT id FROM pending_requests WHERE machine_id=? AND status='pending'")
          .all(machineId) as Array<{ id: string }>;
        for (const row of rows) if (!pendingIds.has(row.id)) this.controlStore.resolvePending(row.id, "expired");
      }
      return;
    }
    if (message.type === "session.event") {
      this.controlStore.appendSessionEvent(machineId, message);
      const status = activityForStructuredEvent(message.eventType);
      if (status) this.controlStore.updateSessionActivity(message.sessionId, status.activity,
        status.active ? message.turnId : undefined, status.lastTurn);
      return;
    }
    if (message.type === "user_input_request") {
      this.controlStore.upsertUserInput(machineId, message);
      return;
    }
    if (message.type === "user_input_resolved") {
      this.controlStore.resolvePending(message.requestId, "resolved_elsewhere");
      return;
    }
    if (message.type === "action.result") {
      this.controlStore.completeAction(message);
      return;
    }
    if (message.type === "heartbeat") {
      this.store.touchMachine(machineId);
      this.reconcileSessionActivity(machineId, message);
      return;
    }
    if (message.type === "bridge_update.check") {
      const bridge = this.bridges.get(machineId);
      if (bridge) bridge.bridgeVersion = message.currentVersion;
      if (bridge) this.sendUpdateAnnouncement(bridge.socket);
      return;
    }
    if (message.type === "bridge.idle") {
      const bridge = this.bridges.get(machineId);
      if (bridge) this.sendUpdateAnnouncement(bridge.socket);
      return;
    }
    if (message.type === "bridge_update.status") {
      if ((message.phase === "failed" || message.phase === "rolled_back"
        || (message.phase === "discovered" && !message.updatable))) {
        this.markPendingRuns(machineId, "update_failed", message.reason ?? "bridge update failed; retry is required");
      }
      await this.handleBridgeUpdateStatus(machineId, message);
      return;
    }
    if (message.type === "session.discovered") {
      await this.handleSessionDiscovered(machineId, message);
      return;
    }
    if (message.type === "log_response") {
      const session = this.store.getSession(message.sessionId);
      if (session?.matrixThreadId) await this.matrix.sendThread(session.matrixThreadId, `📄 Recent log\n\n${truncate(message.text, 6000)}`);
      return;
    }
    if (message.type === "approval_request") {
      await this.handleApprovalRequest(machineId, message);
      return;
    }
    if (message.type === "approval_resolved") {
      this.controlStore.resolvePending(message.approvalId,
        message.choice === "deny" ? "denied" : message.choice ? "accepted" : "resolved_elsewhere",
        message.choice ? { choice: message.choice } : undefined);
      const pending = this.approvalsById.get(message.approvalId);
      if (pending) {
        this.forgetApproval(pending);
        await this.removeApprovalReactions(pending);
        const run = this.store.getWorkerRunBySession(message.sessionId);
        if (run) this.store.updateWorkerRun(run.id, "working");
      } else {
        this.resolvedApprovalIds.add(message.approvalId);
        setTimeout(() => this.resolvedApprovalIds.delete(message.approvalId), 60_000).unref();
      }
      return;
    }
    if (message.type === "error") {
      if (message.sessionId) {
        const workerRun = this.store.getWorkerRun(message.sessionId)
          ?? this.store.getWorkerRunBySession(message.sessionId);
        if (workerRun) {
          this.store.updateWorkerRun(workerRun.id,
            message.code === "update_required" ? "update_required"
              : message.code === "update_failed" ? "update_failed" : "failed",
            message.message);
          if (!workerRun.sessionId) return;
        }
        const launch = this.launchesByRequestId.get(message.sessionId);
        if (launch) {
          this.launchesByRequestId.delete(message.sessionId);
          await this.matrix.sendThread(launch.sourceEventId, `❌ 启动失败：${message.message}`, { kind: "launch.failed" });
          return;
        }
        const session = this.store.getSession(message.sessionId);
        if (session?.matrixThreadId) await this.matrix.sendThread(session.matrixThreadId, `❌ ${message.message}`);
        else log.warn({ machineId, sessionId: message.sessionId, message: message.message }, "Bridge error for unknown session");
      } else {
        log.warn({ machineId, message: message.message }, "Bridge error");
      }
      return;
    }
    if (message.type.startsWith("agent.")) await this.handleAgentEvent(message as AgentEvent);
  }

  private sendUpdateAnnouncement(socket: WebSocket): void {
    if (!this.options.bridgeUpdate) return;
    const { latestVersion, source, publishedAt } = this.options.bridgeUpdate;
    this.send(socket, { type: "bridge_update.available", latestVersion, source, publishedAt,
      epoch: this.updateEpoch() });
  }

  private bridgeNeedsUpdate(bridge: BridgeConnection): boolean {
    return Boolean(this.options.bridgeUpdate
      && (!bridge.bridgeVersion
        || compareBridgeVersions(bridge.bridgeVersion, this.options.bridgeUpdate.latestVersion) < 0));
  }

  private updateEpoch(): string {
    const update = this.options.bridgeUpdate!;
    return `${update.latestVersion}:${update.publishedAt ?? 0}`;
  }

  private queueRunForUpdate(input: Omit<PendingRunLaunch, "targetVersion" | "epoch" | "timeout">): void {
    const update = this.options.bridgeUpdate!;
    const timeout = setTimeout(() => {
      const pending = this.pendingRunLaunches.get(input.runId);
      if (!pending) return;
      this.store.updateWorkerRun(input.runId, "update_required",
        `bridge did not register version ${pending.targetVersion} before the update admission timeout`);
    }, update.admissionTimeoutMs ?? 120_000);
    timeout.unref();
    this.pendingRunLaunches.set(input.runId, { ...input, targetVersion: update.latestVersion,
      epoch: this.updateEpoch(), timeout });
  }

  private markPendingRuns(machineId: string, status: "update_required" | "update_failed", reason: string): void {
    for (const pending of this.pendingRunLaunches.values()) {
      if (pending.machineId === machineId) this.store.updateWorkerRun(pending.runId, status, reason);
    }
  }

  private releasePendingRuns(machineId: string): void {
    const bridge = this.bridges.get(machineId);
    if (!bridge?.bridgeVersion) return;
    for (const [runId, pending] of this.pendingRunLaunches) {
      if (pending.machineId !== machineId
        || compareBridgeVersions(bridge.bridgeVersion, pending.targetVersion) < 0) continue;
      clearTimeout(pending.timeout);
      this.pendingRunLaunches.delete(runId);
      this.store.updateWorkerRun(runId, "starting");
      this.sendStartAgent(bridge, runId, pending.projectPath, pending.prompt, pending.resumeSessionId, pending.model);
    }
  }

  private sendStartAgent(bridge: BridgeConnection, runId: string, projectPath: string,
    prompt: string, resumeSessionId?: string, model?: string): void {
    this.send(bridge.socket, { type: "start_agent", sessionId: runId, resumeSessionId,
      agentType: "codex-cli", projectPath, prompt, model });
  }

  private replayControlActions(machineId: string): void {
    for (const { action, request, path } of this.controlStore.pendingActions(machineId)) {
      if (action.kind === "create_session") this.registry.send(machineId, { type: "action.create_session",
        actionId: action.actionId, projectPath: String(request.workspace),
        input: typeof request.input === "string" ? request.input : undefined,
        model: typeof request.model === "string" ? request.model : undefined });
      else if (action.kind === "submit_turn" && action.sessionId) this.registry.send(machineId, {
        type: "action.submit_turn", actionId: action.actionId, sessionId: action.sessionId,
        input: String(request.input), delivery: (request.delivery ?? "auto") as "auto"|"steer"|"start_turn",
        expectedTurnId: typeof request.expectedTurnId === "string" ? request.expectedTurnId : undefined,
        model: typeof request.model === "string" ? request.model : undefined });
      else if (action.kind === "interrupt_turn" && action.sessionId) this.registry.send(machineId, {
        type: "action.interrupt_turn", actionId: action.actionId, sessionId: action.sessionId,
        expectedTurnId: typeof request.expectedTurnId === "string" ? request.expectedTurnId : undefined });
      else if (action.kind === "resolve_approval" && action.sessionId) this.registry.send(machineId, {
        type: "action.resolve_approval", actionId: action.actionId, sessionId: action.sessionId,
        approvalId: decodeURIComponent(path.split("/").at(-2)!),
        choice: request.choice as ApprovalChoice });
      else if (action.kind === "resolve_user_input" && action.sessionId) this.registry.send(machineId, {
        type: "action.resolve_user_input", actionId: action.actionId, sessionId: action.sessionId,
        requestId: decodeURIComponent(path.split("/").at(-2)!),
        answers: request.answers as Record<string, { answers: string[] }> });
    }
  }

  private reconcileSessionActivity(
    machineId: string,
    heartbeat: Extract<BridgeToControlMessage, { type: "heartbeat" }>,
  ): void {
    // Optional fields keep heartbeats from pre-0.4.1 bridges compatible.
    if (!heartbeat.activeSessionIds) return;
    const waiting = new Set(heartbeat.waitingSessionIds ?? []);
    const blocked = new Set(heartbeat.blockedSessionIds ?? []);
    for (const sessionId of heartbeat.activeSessionIds) {
      const session = this.store.getSession(sessionId);
      if (!session || session.machineId !== machineId) continue;
      const run = this.store.getWorkerRunBySession(sessionId);
      if (!run || ["completed", "failed", "stopped"].includes(run.status)) continue;

      if (waiting.has(sessionId)) {
        this.store.updateSessionStatus(sessionId, "waiting");
        this.store.updateWorkerRun(run.id, "waiting");
      } else if (blocked.has(sessionId)) {
        const hasApproval = [...this.approvalsById.values()].some((approval) => approval.sessionId === sessionId);
        this.store.updateSessionStatus(sessionId, "blocked");
        this.store.updateWorkerRun(run.id, "blocked", hasApproval ? undefined : "Approval pending on bridge");
      } else if (run.status !== "blocked" || !run.error || run.error === "Approval pending on bridge") {
        // A persisted blocked row with neither a pending approval nor a reason
        // is stale. Active bridge state is authoritative and safely repairs it.
        this.store.updateSessionStatus(sessionId, "working");
        this.store.updateWorkerRun(run.id, "working");
      }
    }
  }

  private async handleBridgeUpdateStatus(
    machineId: string,
    message: Extract<BridgeToControlMessage, { type: "bridge_update.status" }>,
  ): Promise<void> {
    if (message.phase === "completed") {
      const bridge = this.bridges.get(machineId);
      if (bridge) bridge.bridgeVersion = message.currentVersion;
    }
    if (message.phase !== "discovered" && message.phase !== "completed") {
      log.info({ machineId, phase: message.phase, currentVersion: message.currentVersion,
        latestVersion: message.latestVersion, reason: message.reason }, "Bridge self-update status");
      return;
    }
    const key = `${message.phase}:${machineId}:${message.latestVersion}`;
    if (this.updateNotifications.has(key)) return;
    this.updateNotifications.add(key);
    if (message.phase === "discovered") {
      await this.matrix.sendNotice([
        `🔔 Bridge 更新已发现：${machineId}`,
        `${message.currentVersion} → ${message.latestVersion}`,
        message.updatable ? "该 bridge 将按本机策略自行更新。" : `不会自动更新：${message.reason ?? "本机策略不允许"}`,
      ].join("\n"), {
        kind: "bridge.update.discovered", machine_id: machineId,
        current_version: message.currentVersion, latest_version: message.latestVersion,
        updatable: message.updatable,
      });
    } else {
      await this.matrix.sendNotice([
        `✅ Bridge 已完成自更新：${machineId}`,
        `当前版本 ${message.currentVersion}`,
      ].join("\n"), {
        kind: "bridge.update.completed", machine_id: machineId,
        current_version: message.currentVersion, latest_version: message.latestVersion,
      });
    }
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const session = this.store.getSession(event.sessionId);
    if (!session) return;
    const workerRun = this.store.getWorkerRunBySession(event.sessionId);
    if (!this.store.addEvent(event, workerRun?.id)) return;
    const status = statusForEvent(event.type);
    const runIsTerminal = workerRun && ["completed", "failed", "stopped"].includes(workerRun.status);
    // App Server can deliver a final item/progress notification just after
    // turn/completed. Preserve it in the event stream, but never resurrect a
    // terminal run or session back to working.
    if (status && !runIsTerminal) this.store.updateSessionStatus(event.sessionId, status);
    if (status && workerRun && !runIsTerminal) {
      const reason = status === "blocked" ? event.summary || event.text || "Bridge reported that the agent is blocked" : undefined;
      this.store.updateWorkerRun(workerRun.id, status, reason);
    }
    if (!session.matrixThreadId) return;
    if (event.type === "agent.started") this.progressNotifiedSessions.delete(event.sessionId);
    if (event.type === "agent.progress") {
      if (this.progressNotifiedSessions.has(event.sessionId)) return;
      this.progressNotifiedSessions.add(event.sessionId);
    }
    if (["agent.completed", "agent.failed", "agent.stopped"].includes(event.type)) {
      this.progressNotifiedSessions.delete(event.sessionId);
    }
    const formatted = formatEvent(event);
    if (formatted) await this.matrix.sendThread(session.matrixThreadId, formatted);
  }

  private async handleApprovalRequest(machineId: string, message: ApprovalRequestMessage): Promise<void> {
    const session = this.store.getSession(message.sessionId);
    if (!session) return;
    if (this.approvalsById.has(message.approvalId)) {
      this.controlStore.upsertApproval(machineId, message);
      return;
    }
    // App Server can resolve a request locally before a delayed/replayed
    // approval_request reaches us. Never persist a reasonless blocked state in
    // that case: there is no pending approval for the API caller to resolve.
    if (this.resolvedApprovalIds.delete(message.approvalId)) return;
    this.controlStore.upsertApproval(machineId, message);
    this.store.updateSessionStatus(message.sessionId, "blocked");
    const workerRun = this.store.getWorkerRunBySession(message.sessionId);
    if (workerRun) this.store.updateWorkerRun(workerRun.id, "blocked");
    const pending: PendingApproval = {
      approvalId: message.approvalId,
      sessionId: message.sessionId,
      machineId,
      threadId: session.matrixThreadId ?? undefined,
      reactionEventIds: [],
      choices: message.choices,
      kind: message.kind,
      summary: message.summary,
    };
    this.approvalsById.set(message.approvalId, pending);
    if (!session.matrixThreadId) return;
    const messageEventId = await this.matrix.sendThread(session.matrixThreadId, [
      `🔐 Codex 请求授权 · ${approvalKindLabel(message.kind)}`,
      "",
      message.summary,
      "",
      "点击下面的表情选择操作：",
      ...approvalActions(message).map((action) => `${action.key} ${action.label}`),
    ].join("\n"));
    pending.messageEventId = messageEventId;
    this.approvalsByEvent.set(messageEventId, pending);
    for (const action of approvalActions(message)) {
      try {
        pending.reactionEventIds.push(await this.matrix.sendReaction(messageEventId, action.key));
      } catch (error) {
        log.warn({ error, approvalId: message.approvalId, reaction: action.key }, "Unable to add approval reaction");
      }
    }
  }

  private forgetApproval(pending: PendingApproval): void {
    if (pending.messageEventId) this.approvalsByEvent.delete(pending.messageEventId);
    this.approvalsById.delete(pending.approvalId);
  }

  private async removeApprovalReactions(pending: PendingApproval): Promise<void> {
    const results = await Promise.allSettled(pending.reactionEventIds.map((eventId) => this.matrix.removeReaction(eventId)));
    if (results.some((result) => result.status === "rejected")) {
      log.warn({ approvalId: pending.approvalId }, "Unable to remove one or more approval reactions");
    }
  }

  private async handleSessionDiscovered(machineId: string, message: SessionDiscoveredMessage): Promise<void> {
    let session = this.store.getSessionByNative(machineId, message.nativeSessionId);
    if (session) {
      this.store.updateSessionStatus(session.id, message.status);
      const workerRun = message.requestId ? this.store.getWorkerRun(message.requestId) : undefined;
      if (workerRun && !workerRun.sessionId) this.store.attachWorkerRun(workerRun.id, session.id, message.status);
      if (!workerRun && !session.matrixThreadId && message.title?.trim()) await this.publishPassiveSession(session, message);
      this.controlStore.upsertSession(machineId, stateForDiscovery(message));
      return;
    }
    const launch = message.requestId ? this.launchesByRequestId.get(message.requestId) : undefined;
    const workerRun = message.requestId ? this.store.getWorkerRun(message.requestId) : undefined;
    const now = Date.now();
    session = {
      id: message.sessionId,
      machineId,
      agentType: message.agentType,
      projectName: message.projectName || basename(message.projectPath.replace(/[\\/]$/, "")) || message.projectPath,
      projectPath: message.projectPath,
      matrixRoomId: this.roomId,
      matrixThreadId: launch?.sourceEventId ?? null,
      nativeSessionId: message.nativeSessionId,
      status: message.status,
      createdAt: message.createdAt || now,
      updatedAt: now,
    };
    this.store.createSession(session);
    if (workerRun) this.store.attachWorkerRun(workerRun.id, session.id, message.status);
    if (launch) {
      this.launchesByRequestId.delete(message.requestId!);
      const bridge = this.bridges.get(machineId);
      await this.matrix.sendThread(launch.sourceEventId, [
        `${statusIcon(message.status)} Codex CLI @ ${bridge?.name ?? machineId}`,
        session.projectPath,
      ].join("\n"), sessionMetadata(session));
    } else if (!workerRun && message.title?.trim()) {
      await this.publishPassiveSession(session, message);
    }
    this.controlStore.upsertSession(machineId, stateForDiscovery(message));
    log.info({ machineId, sessionId: session.id, nativeSessionId: message.nativeSessionId }, "Local Codex thread attached");
  }

  private async publishPassiveSession(session: SessionRecord, message: SessionDiscoveredMessage): Promise<void> {
    const agentLabel = message.agentType === "codex-desktop" ? "Codex Desktop" : "Codex CLI";
    const bridge = this.bridges.get(session.machineId);
    const matrixThreadId = await this.matrix.sendRoot([
      `${statusIcon(message.status)} ${message.title!.trim()}`,
      `${agentLabel} @ ${bridge?.name ?? session.machineId} · ${session.projectName}`,
    ].join("\n"), sessionMetadata(session));
    this.store.setThread(session.id, matrixThreadId);
  }

  private async beginLaunch(launch: PendingLaunch): Promise<void> {
    const targets = [...this.bridges.values()].filter((bridge) => bridge.capabilities.includes("codex-cli"));
    if (!targets.length) {
      await this.matrix.sendNotice("当前没有可用的 Codex bridge。", { kind: "launch.unavailable" });
      return;
    }
    if (targets.length === 1) {
      launch.machineId = targets[0]!.machineId;
      await this.chooseWorkspace(launch);
      return;
    }
    const choices = new Map<string, { machineId: string }>();
    const lines = targets.slice(0, NUMBER_REACTIONS.length).map((target, index) => {
      const key = NUMBER_REACTIONS[index]!;
      choices.set(key, { machineId: target.machineId });
      return `${key} Codex CLI @ ${target.name}`;
    });
    await this.offerLaunchSelection(launch, "把任务交给谁？\n\n" + lines.join("\n"), choices, "launch.agent-choice");
  }

  private async chooseWorkspace(launch: PendingLaunch): Promise<void> {
    const paths = this.store.listProjectPaths(launch.machineId!, NUMBER_REACTIONS.length - 1);
    if (!paths.length) {
      this.launchesAwaitingPath.set(launch.sender, launch);
      await this.matrix.sendNotice("📁 还没有最近目录，请发送绝对路径或 zoxide 查询。", {
        kind: "launch.path-input", machine_id: launch.machineId,
      });
      return;
    }
    const choices = new Map<string, { projectPath?: string; manualPath?: boolean }>();
    const lines = paths.map((path, index) => {
      const key = NUMBER_REACTIONS[index]!;
      choices.set(key, { projectPath: path });
      return `${key} ${path}`;
    });
    choices.set("➕", { manualPath: true });
    lines.push("➕ 新的工作目录（输入路径）");
    await this.offerLaunchSelection(launch, "在哪个目录工作？\n\n" + lines.join("\n"), choices, "launch.workspace-choice");
  }

  private async offerLaunchSelection(
    launch: PendingLaunch,
    body: string,
    choices: Map<string, { machineId?: string; projectPath?: string; manualPath?: boolean }>,
    kind: string,
  ): Promise<void> {
    const messageEventId = await this.matrix.sendNotice(body, { kind, source_event_id: launch.sourceEventId });
    const selection: PendingLaunchSelection = { launch, messageEventId, reactionEventIds: [], choices };
    this.launchSelectionsByEvent.set(messageEventId, selection);
    this.launchSelectionsBySender.set(launch.sender, selection);
    for (const key of choices.keys()) {
      try {
        selection.reactionEventIds.push(await this.matrix.sendReaction(messageEventId, key));
      } catch (error) {
        log.warn({ error, reaction: key }, "Unable to add launch reaction");
      }
    }
  }

  private async resolveLaunchSelection(
    selection: PendingLaunchSelection,
    choice: { machineId?: string; projectPath?: string; manualPath?: boolean },
  ): Promise<void> {
    this.launchSelectionsByEvent.delete(selection.messageEventId);
    this.launchSelectionsBySender.delete(selection.launch.sender);
    await Promise.allSettled(selection.reactionEventIds.map((eventId) => this.matrix.removeReaction(eventId)));
    if (choice.machineId) {
      selection.launch.machineId = choice.machineId;
      await this.chooseWorkspace(selection.launch);
    } else if (choice.manualPath) {
      this.launchesAwaitingPath.set(selection.launch.sender, selection.launch);
      await this.matrix.sendNotice("📁 请发送绝对路径或 zoxide 查询。", {
        kind: "launch.path-input", machine_id: selection.launch.machineId,
      });
    } else if (choice.projectPath) {
      await this.startLaunch(selection.launch, choice.projectPath);
    }
  }

  private async startLaunch(launch: PendingLaunch, projectPath: string): Promise<void> {
    const bridge = launch.machineId ? this.bridges.get(launch.machineId) : undefined;
    if (!bridge) {
      await this.matrix.sendThread(launch.sourceEventId, "❌ 所选 bridge 已离线。", { kind: "launch.failed" });
      return;
    }
    const requestId = randomUUID();
    this.launchesByRequestId.set(requestId, { ...launch, machineId: bridge.machineId, projectPath });
    this.send(bridge.socket, {
      type: "start_agent", sessionId: requestId, agentType: launch.agentType, projectPath, prompt: launch.prompt,
    });
    await this.matrix.sendThread(launch.sourceEventId, `⏳ Codex CLI @ ${bridge.name} · ${projectPath}`, {
      kind: "launch.starting", request_id: requestId, machine_id: bridge.machineId, project_path: projectPath,
    });
  }

  private async cancelLaunch(sender: string): Promise<void> {
    this.launchesAwaitingPath.delete(sender);
    const selection = this.launchSelectionsBySender.get(sender);
    if (!selection) return;
    this.launchSelectionsBySender.delete(sender);
    this.launchSelectionsByEvent.delete(selection.messageEventId);
    await Promise.allSettled(selection.reactionEventIds.map((eventId) => this.matrix.removeReaction(eventId)));
  }

  private async createCodexSession(requestedMachine: string | undefined, projectPath: string, prompt?: string): Promise<void> {
    const bridge = requestedMachine
      ? this.bridges.get(requestedMachine)
      : [...this.bridges.values()][0];
    if (!bridge) {
      await this.matrix.sendNotice(requestedMachine ? `Bridge ${requestedMachine} is offline.` : "No online bridge is available.");
      return;
    }
    const requestId = randomUUID();
    this.send(bridge.socket, { type: "start_agent", sessionId: requestId, agentType: "codex-cli", projectPath, prompt });
    await this.matrix.sendNotice(`🟢 Starting Codex on ${bridge.machineId}: ${projectPath}`);
  }

  private send(socket: WebSocket, message: ControlToBridgeMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return value === undefined ? undefined : stringField(body, name);
}

function workerRunJson(run: WorkerRunRecord): Record<string, unknown> {
  return {
    runId: run.id,
    taskId: run.taskId,
    conversationId: run.conversationId,
    workerId: `codex@${run.machineId}`,
    machineId: run.machineId,
    agent: run.agentType,
    workspace: run.projectPath,
    sessionId: run.sessionId,
    status: run.status,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function statusIcon(status: string): string {
  return ({ starting: "🟢", update_waiting: "🟠", update_required: "🟠", update_failed: "🔴",
    working: "🔵", waiting: "🟡", blocked: "🔴", completed: "✅", failed: "❌", stopped: "⚫" } as Record<string, string>)[status] ?? "⚪";
}

function compareBridgeVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return [-1, -1, -1, value];
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1;
  }
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3], undefined, { numeric: true });
}

function sessionMetadata(session: SessionRecord): Record<string, string> {
  return {
    kind: "session",
    session_id: session.id,
    native_session_id: session.nativeSessionId ?? "",
    machine_id: session.machineId,
    agent_type: session.agentType,
    project_path: session.projectPath,
  };
}

function approvalKindLabel(kind: ApprovalRequestMessage["kind"]): string {
  return ({ command: "执行命令", "file-change": "修改文件", permissions: "额外权限" })[kind];
}

function approvalActions(message: ApprovalRequestMessage): ReadonlyArray<{ key: string; choice: ApprovalChoice; label: string }> {
  return APPROVAL_REACTIONS.filter((action) => message.choices.includes(action.choice));
}

export function formatEvent(event: AgentEvent): string | undefined {
  const text = event.summary ?? event.text ?? "";
  switch (event.type) {
    // Native Codex is the primary interface. Keep transient events in SQLite and
    // /log without generating a new Matrix notification for every update.
    case "agent.started":
    case "agent.output": return undefined;
    case "agent.progress": return text ? `🔵 Progress\n\n${truncate(text, 3500)}` : `🔵 Progress\n\nCodex is responding.`;
    case "agent.waiting": return `🟡 Needs input${text ? `\n\n${text}` : ""}`;
    case "agent.blocked": return `🔴 Agent blocked${text ? `\n\n${text}` : ""}`;
    case "agent.completed": return `✅ Completed${text ? `\n\n${text}` : ""}${event.durationMs ? `\nDuration: ${formatDuration(event.durationMs)}` : ""}`;
    case "agent.failed": return `❌ Failed${text ? `\n\n${text}` : ""}${event.exitCode !== undefined ? `\nExit code: ${event.exitCode}` : ""}`;
    case "agent.stopped": return "⚫ Stopped";
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-(limit - 1))}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function stateForDiscovery(message: SessionDiscoveredMessage): SessionState {
  const active = message.status === "working" || message.status === "starting";
  const activityStatus: SessionActivityStatus = active ? "active"
    : message.status === "blocked" ? "waiting_for_approval"
      : message.status === "failed" ? "error" : "idle";
  const lastTurnStatus = message.status === "completed" ? "completed"
    : message.status === "failed" ? "failed" : message.status === "stopped" ? "interrupted" : undefined;
  return { sessionId: message.sessionId, nativeSessionId: message.nativeSessionId,
    agentType: message.agentType, projectPath: message.projectPath,
    projectName: message.projectName || basename(message.projectPath.replace(/[\\/]$/, "")) || message.projectPath,
    title: message.title, promptSummary: message.promptSummary, activityStatus,
    lastTurnStatus, createdAt: message.createdAt, updatedAt: Date.now(), source: message.agentType === "codex-desktop"
      ? "desktop-rollout" : "app-server", historyCompleteness: message.agentType === "codex-desktop"
      ? "terminal-only" : "loaded-only" };
}

function activityForStructuredEvent(type: string):
  { activity: SessionActivityStatus; active: boolean; lastTurn?: "completed"|"failed"|"interrupted" } | undefined {
  if (type === "turn.started") return { activity: "active", active: true };
  if (type === "approval.requested") return { activity: "waiting_for_approval", active: true };
  if (type === "user_input.requested") return { activity: "waiting_for_input", active: true };
  if (type === "turn.completed") return { activity: "idle", active: false, lastTurn: "completed" };
  if (type === "turn.failed") return { activity: "idle", active: false, lastTurn: "failed" };
  if (type === "turn.interrupted") return { activity: "idle", active: false, lastTurn: "interrupted" };
  return undefined;
}
