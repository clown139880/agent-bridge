import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { AgentControlStore, ConversationMemoryStore, Store, type SessionRecord } from "@agent-bridge/database";
import {
  parseMessage,
  statusForEvent,
  type AgentEvent,
  type AgentType,
  type ApprovalChoice,
  type ApprovalRequestMessage,
  type AttachmentRef,
  type BridgeToControlMessage,
  type ControlToBridgeMessage,
  type RegisterMessage,
  type SessionDiscoveredMessage,
  type SessionActivityStatus,
  type SessionState,
} from "@agent-bridge/protocol";
import type { ControlGateway } from "./matrix.js";
import { AgentControlApi } from "./api/router.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { WebhookNotifier, type WebhookOptions } from "./webhook.js";
import { AgentMemory, AgentSkills, type Writer } from "@agent-bridge/agent-memory";
import { ConversationMcpServer } from "./memory-mcp.js";
import { compareBridgeVersions } from "./bridge-version.js";
import { PostDeployResumer } from "./post-deploy.js";

const log = pino({ name: "control-plane" });

interface PendingLaunch {
  sender: string;
  prompt: string;
  sourceEventId: string;
  machineId?: string;
  agentType: AgentType;
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
const ORPHANED_RUN_REASON = "The worker's Bridge restarted and no longer holds this run's session; its turn was interrupted";

export class ControlPlane {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly registry = new BridgeRegistry();
  private readonly bridges = this.registry.connections;
  private readonly controlStore: AgentControlStore;
  private readonly controlApi: AgentControlApi;
  private readonly webhook: WebhookNotifier;
  private readonly memory: ConversationMemoryStore;
  private readonly memoryMcp?: ConversationMcpServer;
  private readonly approvalsByEvent = new Map<string, PendingApproval>();
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly resolvedApprovalIds = new Set<string>();
  private readonly progressNotifiedSessions = new Set<string>();
  private readonly seenAgentEvents = new Set<string>();
  private readonly launchSelectionsByEvent = new Map<string, PendingLaunchSelection>();
  private readonly launchSelectionsBySender = new Map<string, PendingLaunchSelection>();
  private readonly launchesAwaitingPath = new Map<string, PendingLaunch>();
  private readonly launchesByRequestId = new Map<string, PendingLaunch & { machineId: string; projectPath: string }>();
  private readonly updateNotifications = new Set<string>();
  /** Bridge version this process already announced per machine, so a self-update's own report is not repeated. */
  private readonly announcedBridgeVersions = new Map<string, string>();
  private readonly postDeploy: PostDeployResumer;
  private roomId = "";
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly matrix: ControlGateway,
    private readonly options: {
      /** Where deploy/hal/deploy.sh leaves post-deploy intents (see PostDeployResumer). */
      postDeployDir?: string;
      version?: string;
      host: string;
      port: number;
      bridgeToken?: string;
      workerApiEnabled?: boolean;
      workerApiToken?: string;
      controlApiReadToken?: string;
      controlApiWriteToken?: string;
      conversationMemory?: { mcpReadToken?: string };
      agentMemory?: { vault: string; root?: string; lockPath?: string; cacheDir?: string; writers: Array<Writer & { token: string }>;
        skills?: { repo: string; lockPath?: string; archiveDir: string; push: boolean } };
      retention?: { actionsMs: number; attachmentsMs: number };
      sse?: { keepaliveMs: number; pollMs: number; maxBackpressure: number; actionTimeoutMs?: number };
      bridgeUpdate?: {
        latestVersion: string;
        source: string;
        publishedAt?: number;
      };
      webhook?: WebhookOptions;
    },
  ) {
    this.webhook = new WebhookNotifier(options.webhook);
    this.memory = new ConversationMemoryStore(store.db);
    let agentMemory: AgentMemory | undefined;
    if (options.agentMemory) {
      try { agentMemory = new AgentMemory(options.agentMemory); }
      catch (error) { log.error({ error }, "Agent memory disabled: vault unavailable"); }
    }
    let agentSkills: AgentSkills | undefined;
    if (agentMemory && options.agentMemory?.skills) {
      try {
        agentSkills = new AgentSkills({ ...options.agentMemory.skills,
          onPushError: (message) => log.warn({ message }, "Skill library push failed; the next write retries") });
      }
      catch (error) { log.error({ error }, "Skill library disabled: repository unavailable"); }
    }
    if (options.conversationMemory?.mcpReadToken || agentMemory) {
      this.memoryMcp = new ConversationMcpServer(this.memory, options.conversationMemory?.mcpReadToken,
        agentMemory && { store: agentMemory, skills: agentSkills, writers: options.agentMemory!.writers });
    }
    this.controlStore = new AgentControlStore(store.db, options.retention ?? {
      actionsMs: 86_400_000, attachmentsMs: 7 * 86_400_000,
    });
    this.controlApi = new AgentControlApi(store, this.controlStore, this.registry, {
      workerToken: options.workerApiToken, readToken: options.controlApiReadToken,
      writeToken: options.controlApiWriteToken, bridgeToken: options.bridgeToken,
      sseKeepaliveMs: options.sse?.keepaliveMs ?? 15_000,
      ssePollMs: options.sse?.pollMs ?? 2_000, sseMaxBackpressure: options.sse?.maxBackpressure ?? 3,
      actionTimeoutMs: options.sse?.actionTimeoutMs ?? 30_000,
    });
    this.postDeploy = new PostDeployResumer(options.postDeployDir, {
      resolveSession: (intent) => {
        const session = (intent.sessionId ? this.store.getSession(intent.sessionId) : undefined)
          ?? (intent.nativeSessionId ? this.store.getSessionByNative(intent.machineId, intent.nativeSessionId) : undefined);
        return session ? { id: session.id, machineId: session.machineId } : undefined;
      },
      submitTurn: (sessionId, machineId, key, input) => {
        const created = this.controlStore.createAction({ principal: "system:post-deploy", key, method: "POST",
          path: `/api/v1/sessions/${sessionId}/turns`, body: { input, delivery: "auto" }, kind: "submit_turn", machineId, sessionId });
        if (created.existing) return;
        this.controlApi.actionsForBridge().dispatch(created.action, { type: "action.submit_turn", actionId: created.action.actionId,
          sessionId, input, delivery: "auto", resume: this.resumeContext(sessionId) });
      },
    });
    this.http = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, bridges: this.bridges.size, roomId: this.roomId }));
        return;
      }
      if (new URL(request.url ?? "/", "http://localhost").pathname === "/mcp") {
        if (!this.memoryMcp) { response.writeHead(404).end(); return; }
        void this.memoryMcp.handle(request, response).catch((error) => {
          log.error({ error }, "Conversation MCP request failed");
          if (!response.headersSent) this.json(response, 500, { error: "internal_error" });
          else response.end();
        });
        return;
      }
      if (request.url?.startsWith("/api/v1/")) {
        if (!this.options.workerApiEnabled && !this.options.controlApiReadToken && !this.options.controlApiWriteToken) {
          response.writeHead(404).end();
          return;
        }
        void this.controlApi.handle(request, response).catch((error) => {
          log.error({ error }, "Control API request failed");
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
    // No bridge is live yet after a control-plane restart. Reset transient state
    // without changing the timestamp of the session's last real activity.
    this.controlStore.resetTransientSessionActivity();
    this.roomId = await this.matrix.start();
    await new Promise<void>((resolve) => this.http.listen(this.options.port, this.options.host, resolve));
    setInterval(() => this.store.markStaleMachinesOffline(Date.now() - 45_000), 15_000).unref();
    this.controlStore.cleanup();
    this.cleanupTimer = setInterval(() => this.controlStore.cleanup(), 60 * 60_000);
    this.cleanupTimer.unref();
    log.info({ host: this.options.host, port: this.options.port, roomId: this.roomId }, "Control plane listening");
    // Announce the control-plane restart and the version it is advertising to the fleet.
    // This is the operator's "control-plane upgraded / broadcasting version" signal.
    this.webhook.notify({
      type: "control_plane.up",
      version: this.options.version ?? "unknown",
      latest_bridge_version: this.options.bridgeUpdate?.latestVersion ?? null,
      update_source: this.options.bridgeUpdate?.source ?? null,
      update_published_at: this.options.bridgeUpdate?.publishedAt ?? null,
    });
  }

  async stop(): Promise<void> {
    this.matrix.stop();
    clearInterval(this.cleanupTimer);
    for (const bridge of this.bridges.values()) bridge.socket.close(1001, "server shutdown");
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private deleteSessionRecord(sessionId: string): void {
    this.controlStore.deleteSession(sessionId);
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
          registeredAt: Date.now(),
        });
        this.store.upsertMachine({
          id: registeredId, name: message.name || registeredId, platform: message.platform,
          hostname: message.hostname, capabilities: message.capabilities,
        });
        const previousVersion = this.controlStore.machineBridgeVersion(registeredId);
        this.controlStore.updateMachineConnection(registeredId, message.bridgeVersion,
          message.protocolVersion, message.features, message.sharedSkills);
        this.send(socket, { type: "registered", machineId: registeredId });
        this.sendUpdateAnnouncement(socket);
        this.replayControlActions(registeredId);
        this.postDeploy.bridgeRegistered(registeredId, message.bridgeVersion);
        log.info({ machineId: registeredId }, "Bridge registered");
        // A Bridge deployed in place (HAL's deploy.sh) never reports a self-update;
        // its first registration on a new version is the only sign it was updated.
        if (previousVersion && message.bridgeVersion && previousVersion !== message.bridgeVersion) {
          this.announcedBridgeVersions.set(registeredId, message.bridgeVersion);
          this.webhook.notify({ type: "bridge_update.status", machine_id: registeredId, phase: "completed",
            current_version: previousVersion, latest_version: message.bridgeVersion, updatable: true });
        }
        // Operator-facing counterpart to bridge.offline: a bridge (re)connected. `needs_update`
        // and `latest_bridge_version` let Dorothy show whether this bridge will self-update.
        this.webhook.notify({
          type: "bridge.online",
          machine_id: registeredId,
          name: message.name || registeredId,
          platform: message.platform ?? null,
          hostname: message.hostname ?? null,
          bridge_version: message.bridgeVersion ?? null,
          protocol_version: message.protocolVersion ?? null,
          capabilities: message.capabilities,
          latest_bridge_version: this.options.bridgeUpdate?.latestVersion ?? null,
          needs_update: Boolean(this.options.bridgeUpdate
            && (!message.bridgeVersion
              || compareBridgeVersions(message.bridgeVersion, this.options.bridgeUpdate.latestVersion) < 0)),
        });
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
        this.webhook.notify({ type: "bridge.offline", machine_id: machineId });
      }
    });
    socket.on("error", (error) => log.warn({ error, machineId }, "Bridge socket error"));
  }

  private async handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void> {
    if (message.type === "archive.gap") {
      this.memory.recordGap(message.gapId, machineId, message.firstEventId, message.lastEventId,
        message.droppedCount, message.reason);
      const bridge = this.bridges.get(machineId);
      if (bridge) this.send(bridge.socket, { type: "archive.gap_ack", gapId: message.gapId });
      return;
    }
    if (message.type === "state.snapshot") {
      for (const session of message.sessions) this.controlStore.upsertSession(machineId, session);
      for (const session of message.sessions) this.memory.upsertSessionProject(session.sessionId, session.projectIdentity);
      for (const approval of message.approvals) await this.handleApprovalRequest(machineId,
        { type: "approval_request", ...approval });
      for (const input of message.userInputs) this.controlStore.upsertUserInput(machineId, input);
      if (message.complete) {
        // A restarted worker may no longer own an old live session. Its complete
        // inventory must clear that old turn, otherwise clients steer forever.
        const present = new Set(message.sessions.map(session => session.sessionId));
        const stale = this.store.db.prepare("SELECT id,active_turn_id FROM sessions WHERE machine_id=? AND (active_turn_id IS NOT NULL OR activity_status IN ('active','waiting_for_approval','waiting_for_input'))")
          .all(machineId) as Array<{id:string;active_turn_id:string|null}>;
        for (const session of stale) if (!present.has(session.id)) {
          if (session.active_turn_id) this.controlStore.appendSessionEvent({
            type: "session.event", sessionId: session.id, turnId: session.active_turn_id,
            eventId: `snapshot:${session.id}:${session.active_turn_id}:interrupted`,
            eventType: "turn.interrupted", timestamp: Date.now(), payload: {reason:"worker no longer owns this turn"},
          });
          this.controlStore.updateSessionActivity(session.id, "offline", undefined, "interrupted");
        }
        this.reclaimOrphanedRuns(machineId, present);
        const pendingIds = new Set([...message.approvals.map((item) => item.approvalId),
          ...message.userInputs.map((item) => item.requestId)]);
        const rows = this.store.db.prepare("SELECT id FROM pending_requests WHERE machine_id=? AND status='pending'")
          .all(machineId) as Array<{ id: string }>;
        for (const row of rows) if (!pendingIds.has(row.id)) this.controlStore.resolvePending(row.id, "expired");
      }
      return;
    }
    if (message.type === "session.event") {
      // Claude inventory is keyed by its native transcript id, while sessions
      // launched through Bridge retain their original public identity.
      const canonical = this.store.getSession(message.sessionId) ?? this.store.getSessionByNative(machineId, message.sessionId);
      if (!canonical) {
        // A persisted outbox can outlive local session metadata (for example,
        // after the source deleted a session while offline). Do not retry the
        // impossible FK forever: retain an explicit collection gap unless the
        // central tombstone already confirms intentional deletion, then ACK.
        if (!this.controlStore.isSessionDeleted(message.sessionId)) {
          this.memory.recordGap(`missing-session:${machineId}:${message.eventId}`, machineId,
            message.eventId, message.eventId, 1, "session-metadata-missing");
        }
        const bridge = this.bridges.get(machineId);
        if (bridge) this.send(bridge.socket, { type: "archive.ack", eventId: message.eventId });
        return;
      }
      if (canonical && canonical.machineId === machineId && canonical.id !== message.sessionId) {
        const oldId = message.sessionId;
        message = { ...message, sessionId: canonical.id,
          eventId: message.eventId === `claude:${oldId}:first:user` ? `claude:${canonical.id}:first:user` : message.eventId };
      }
      const inserted = this.controlStore.appendSessionEvent(message);
      if (inserted === false) {
        const conflict = this.controlStore.reconcileReplayedEvent(message);
        if (conflict) log.warn({ machineId, sessionId: message.sessionId, eventId: message.eventId, eventType: message.eventType,
          turnId: message.turnId, ...conflict }, "Dropped a session event whose id is already stored with different content");
      }
      const bridge = this.bridges.get(machineId);
      if (bridge) this.send(bridge.socket, { type: "archive.ack", eventId: message.eventId });
      // Only a first-seen event may drive the live activity state machine. The
      // durable archive stream replays events on a missed ack or reconnect, and
      // a replayed turn.started would otherwise resurrect a finished turn (a
      // stale active_turn_id + "active"/"waiting_*" status the client can never
      // clear). Duplicates carry no new state.
      if (inserted) {
        const status = activityForStructuredEvent(message.eventType);
        if (status) this.controlStore.updateSessionActivity(message.sessionId, status.activity,
          status.active ? message.turnId : undefined, status.lastTurn);
      }
      return;
    }
    if (message.type === "model_catalog_response") {
      this.registry.resolveModels(machineId, message.requestId, message.error ? { error: message.error, models: [] } : { models: message.models ?? [] });
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
    if (message.type === "action.progress") {
      this.controlApi.actionsForBridge().renew(message.actionId, message.leaseMs);
      return;
    }
    if (message.type === "action.result") {
      this.controlApi.actionsForBridge().complete(message);
      if (message.kind === "delete_session" && message.status === "succeeded" && message.sessionId)
        this.deleteSessionRecord(message.sessionId);
      return;
    }
    if (message.type === "session.deleted") {
      this.deleteSessionRecord(message.sessionId);
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
      await this.handleBridgeUpdateStatus(machineId, message);
      return;
    }
    if (message.type === "session.discovered") {
      await this.handleSessionDiscovered(machineId, message);
      this.memory.upsertSessionProject(message.sessionId, message.projectIdentity);
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

  private updateEpoch(): string {
    const update = this.options.bridgeUpdate!;
    return `${update.latestVersion}:${update.publishedAt ?? 0}`;
  }

  // Resume hint for submit_turn: lets the bridge revive a session it no longer
  // holds in memory (e.g. a Claude subprocess killed by a bridge restart/self-update)
  // by relaunching the agent in the session's workspace and resuming its native id.
  private resumeContext(sessionId: string): { agentType: AgentType; workspace: string; nativeSessionId?: string; syncedAt?: number } | undefined {
    const session = this.store.getSession(sessionId);
    if (!session || !session.projectPath) return undefined;
    return { agentType: session.agentType, workspace: session.projectPath,
      nativeSessionId: session.nativeSessionId || undefined, syncedAt: this.controlStore.lastEventAt(sessionId) };
  }

  private replayControlActions(machineId: string): void {
    for (const { action, request, path } of this.controlStore.pendingActions(machineId)) {
      if (action.kind === "create_session") this.registry.send(machineId, { type: "action.create_session",
        actionId: action.actionId, projectPath: String(request.workspace),
        input: typeof request.input === "string" ? request.input : undefined,
        model: typeof request.model === "string" ? request.model : undefined,
        reasoningEffort: typeof request.reasoningEffort === "string" ? request.reasoningEffort : undefined,
        attachments: attachmentsFromBody(request) });
      else if (action.kind === "submit_turn" && action.sessionId) this.registry.send(machineId, {
        type: "action.submit_turn", actionId: action.actionId, sessionId: action.sessionId,
        input: String(request.input), delivery: (request.delivery ?? "auto") as "auto"|"steer"|"start_turn",
        expectedTurnId: typeof request.expectedTurnId === "string" ? request.expectedTurnId : undefined,
        model: typeof request.model === "string" ? request.model : undefined,
        reasoningEffort: typeof request.reasoningEffort === "string" ? request.reasoningEffort : undefined,
        attachments: attachmentsFromBody(request), resume: this.resumeContext(action.sessionId) });
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
      else if (action.kind === "delete_session" && action.sessionId) this.registry.send(machineId, {
        type: "action.delete_session", actionId: action.actionId, sessionId: action.sessionId,
        agentType: this.resumeContext(action.sessionId)?.agentType });
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

  /**
   * A run is driven by its session's live turn. When a worker's complete
   * inventory no longer holds that session (its Bridge restarted mid-turn), no
   * terminal agent event will ever arrive, so the run would stay "working"
   * forever. Close such runs, including leftover update_* rows from the removed
   * launch queue. A run this connection started or one whose session has a queued
   * turn (e.g. a post-deploy continuation that revives it) is still owned.
   */
  private reclaimOrphanedRuns(machineId: string, present: Set<string>): void {
    const registeredAt = this.bridges.get(machineId)?.registeredAt ?? Date.now();
    const queued = new Set(this.controlStore.pendingActions(machineId)
      .map(({ action }) => action.sessionId).filter(Boolean));
    const runs = this.store.db.prepare(`SELECT id,session_id FROM worker_runs WHERE machine_id=?
      AND status IN ('starting','working','blocked','update_waiting','update_required','update_failed') AND updated_at<?`)
      .all(machineId, registeredAt) as Array<{ id: string; session_id: string | null }>;
    for (const run of runs) {
      if (run.session_id && (present.has(run.session_id) || queued.has(run.session_id))) continue;
      this.store.updateWorkerRun(run.id, "failed", ORPHANED_RUN_REASON);
      if (run.session_id) this.store.updateSessionStatus(run.session_id, "failed");
      log.info({ machineId, runId: run.id, sessionId: run.session_id }, "Closed a run its restarted worker no longer holds");
    }
  }

  private async handleBridgeUpdateStatus(
    machineId: string,
    message: Extract<BridgeToControlMessage, { type: "bridge_update.status" }>,
  ): Promise<void> {
    // Relay operator-relevant update phases to Dorothy's bridge-events webhook.
    const announced = message.phase === "completed" && this.announcedBridgeVersions.get(machineId) === message.currentVersion;
    if (["discovered", "completed", "failed", "rolled_back"].includes(message.phase) && !announced) {
      this.webhook.notify({
        type: "bridge_update.status", machine_id: machineId, phase: message.phase,
        current_version: message.currentVersion, latest_version: message.latestVersion,
        updatable: message.updatable, reason: message.reason,
      });
    }
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
    // Legacy agent events are signals, not history (the structured session events
    // are). Only a replay of a recently seen event is dropped.
    if (event.eventId) {
      const key = `${event.sessionId}\0${event.eventId}`;
      if (this.seenAgentEvents.has(key)) return;
      this.seenAgentEvents.add(key);
      if (this.seenAgentEvents.size > 4_096) this.seenAgentEvents.delete(this.seenAgentEvents.values().next().value!);
    }
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
    if (this.controlStore.isSessionDeleted(message.sessionId)) return;
    // A Claude session is re-announced once its native uuid is known; match it by
    // its stable public id so the native id is corrected rather than forked.
    const known = this.store.getSession(message.sessionId);
    let session = (message.nativeSessionId ? this.store.getSessionByNative(machineId, message.nativeSessionId) : undefined)
      ?? (known?.machineId === machineId ? known : undefined);
    if (session) {
      this.store.updateSessionStatus(session.id, message.status);
      const workerRun = message.requestId ? this.store.getWorkerRun(message.requestId) : undefined;
      if (workerRun && !workerRun.sessionId) this.store.attachWorkerRun(workerRun.id, session.id, message.status);
      if (!workerRun && !session.matrixThreadId && message.title?.trim()) await this.publishPassiveSession(session, message);
      const previousUpdatedAt=this.controlStore.session(session.id)?.updatedAt;
      this.controlStore.upsertSession(machineId, stateForDiscovery({ ...message, sessionId: session.id },
        typeof previousUpdatedAt==="number"?previousUpdatedAt:undefined));
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
      nativeSessionId: message.nativeSessionId ?? null,
      status: message.status,
      createdAt: message.createdAt || now,
      updatedAt: message.createdAt || now,
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
    const previousUpdatedAt=this.controlStore.session(message.sessionId)?.updatedAt;
    this.controlStore.upsertSession(machineId, stateForDiscovery(message,
      typeof previousUpdatedAt==="number"?previousUpdatedAt:undefined));
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

/** Best-effort read of attachment refs from a replayed action body. */
function attachmentsFromBody(body: Record<string, unknown>): AttachmentRef[] | undefined {
  const value = body.attachments;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({ id: String(item.id ?? ""), filename: String(item.filename ?? ""),
      mimeType: String(item.mimeType ?? ""), size: typeof item.size === "number" ? item.size : 0 }))
    .filter((ref) => ref.id && ref.mimeType);
}

function statusIcon(status: string): string {
  return ({ starting: "🟢", update_waiting: "🟠", update_required: "🟠", update_failed: "🔴",
    working: "🔵", waiting: "🟡", blocked: "🔴", completed: "✅", failed: "❌", stopped: "⚫" } as Record<string, string>)[status] ?? "⚪";
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

function stateForDiscovery(message: SessionDiscoveredMessage, previousUpdatedAt?: number): SessionState {
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
    lastTurnStatus, createdAt: message.createdAt, updatedAt: message.updatedAt ?? previousUpdatedAt ?? message.createdAt, source: message.agentType === "codex-desktop"
      ? "desktop-rollout" : "app-server", historyCompleteness: message.agentType === "codex-desktop"
      ? "terminal-only" : "loaded-only" };
}

function activityForStructuredEvent(type: string):
  { activity: SessionActivityStatus; active: boolean; lastTurn?: "completed"|"failed"|"interrupted" } | undefined {
  if (type === "turn.started") return { activity: "active", active: true };
  // waiting_for_approval / waiting_for_input are owned by the pending-request
  // lifecycle (upsertApproval / upsertUserInput / refreshPendingActivity) so the
  // status stays in lockstep with pendingApprovalCount/pendingUserInputCount. The
  // durable event stream must not set them independently: a dropped best-effort
  // approval_request or a replayed approval.requested would otherwise leave a
  // session "waiting" with zero pending rows — a state no client can resolve.
  if (type === "turn.completed") return { activity: "idle", active: false, lastTurn: "completed" };
  if (type === "turn.failed") return { activity: "idle", active: false, lastTurn: "failed" };
  if (type === "turn.interrupted") return { activity: "idle", active: false, lastTurn: "interrupted" };
  return undefined;
}
