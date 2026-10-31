import { Conversations } from "./conversations.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Context } from "hono";
import { getRequestListener } from "@hono/node-server";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { AgentControlStore, ConversationMemoryStore, Store } from "@agent-bridge/database";
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
  type UserInputRequestMessage,
} from "@agent-bridge/protocol";
import { AgentControlApi } from "./api/router.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { WebhookNotifier, type WebhookOptions } from "./webhook.js";
import { OperatorNotices, type NoticeTarget, type OperatorEvent } from "./notices.js";
import { Automations, type AutomationOptions } from "./automations.js";
import { SecretStore, type SecretStoreOptions } from "./secrets.js";
import { ToolHub } from "./tools.js";
import { toolsEndpoint } from "./mcp/tools.js";
import { NtfyNotifier, type NtfyOptions, type SessionNotificationKind } from "./ntfy.js";
import { AgentMessagePublisher, type MessageMqttOptions } from "./message-publisher.js";
import { AgentMemory, AgentSkills, type Writer } from "@agent-bridge/agent-memory";
import { ConversationMcpServer } from "./memory-mcp.js";
import { memoryEndpoint, reviewContext, runMemoryTool, type AgentMemoryMcpOptions } from "./mcp/memory.js";
import { claudeReviewer, MemoryReviews } from "./memory-review.js";
import { mcpRoute } from "./mcp/route.js";
import { bridgeEndpoint } from "./mcp/bridge.js";
import { compareBridgeVersions } from "./bridge-version.js";
import { PostDeployResumer } from "./post-deploy.js";
import { createHttpApp, type HttpEnv } from "./http.js";

const log = pino({ name: "control-plane" });

/** An approval request this process has seen and not yet resolved; dedupes replays. */
interface PendingApproval {
  approvalId: string;
  sessionId: string;
}

const ORPHANED_RUN_REASON = "The worker's Bridge restarted and no longer holds this run's session; its turn was interrupted";

export class ControlPlane {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly registry = new BridgeRegistry();
  private readonly bridges = this.registry.connections;
  private readonly controlStore: AgentControlStore;
  private readonly controlApi: AgentControlApi;
  private readonly webhook: WebhookNotifier;
  /** Lifecycle events as notices in the operator's chat room (CONTROL_NOTICE_TARGET). */
  private operatorNotices?: OperatorNotices;
  private readonly automations?: Automations;
  private readonly toolHub?: ToolHub;
  private readonly ntfy: NtfyNotifier;
  private readonly messages?: AgentMessagePublisher;
  private readonly memory: ConversationMemoryStore;
  private readonly memoryMcp?: ConversationMcpServer;
  private readonly memoryReviews?: MemoryReviews;
  private readonly agentMemory?: AgentMemory;
  private readonly conversations: Conversations;
  private readonly approvalsById = new Map<string, PendingApproval>();
  private readonly resolvedApprovalIds = new Set<string>();
  private readonly seenAgentEvents = new Set<string>();
  /** Bridge version this process already announced per machine, so a self-update's own report is not repeated. */
  private readonly announcedBridgeVersions = new Map<string, string>();
  private readonly postDeploy: PostDeployResumer;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly options: {
      /** Where deploy/hal/deploy.sh leaves post-deploy intents (see PostDeployResumer). */
      postDeployDir?: string;
      version?: string;
      host: string;
      port: number;
      bridgeToken?: string;
      controlApiReadToken?: string;
      controlApiWriteToken?: string;
      /** AGENT_TOKENS: one per agent, for /mcp/memory, /mcp/bridge and /api/v1. */
      agents?: Array<Writer & { token: string }>;
      agentMemory?: { vault: string; root?: string; lockPath?: string; cacheDir?: string;
        skills?: { repo: string; lockPath?: string; archiveDir: string; push: boolean } };
      /** Where an unbound chat room's messages go, so an agent can help set the room up. */
      conversationSetup?: { workerId: string; workspace: string };
      /** Without a reviewer every held memory write waits for the human. */
      memoryReview?: { reviewer?: { command: string; model: string; timeoutMs: number } };
      retention?: { actionsMs: number; attachmentsMs: number };
      sse?: { keepaliveMs: number; pollMs: number; maxBackpressure: number; actionTimeoutMs?: number };
      bridgeUpdate?: {
        latestVersion: string;
        source: string;
        publishedAt?: number;
      };
      webhook?: WebhookOptions;
      /** The operator's room for lifecycle notices, e.g. `matrix:!room:server`. */
      noticeTarget?: NoticeTarget;
      /** Schedules and webhooks; failures and proposals go to `noticeTarget`, else the App. */
      automations?: Omit<AutomationOptions, "operatorTarget">;
      secrets?: SecretStoreOptions;
      /** The central tool registry (YAML), served at /mcp/tools. */
      toolsRegistry?: string;
      ntfy?: NtfyOptions;
      messages?: MessageMqttOptions;
    },
  ) {
    this.webhook = new WebhookNotifier(options.webhook);
    this.ntfy = new NtfyNotifier(options.ntfy);
    this.memory = new ConversationMemoryStore(store.db);
    let agentMemory: AgentMemory | undefined;
    if (options.agentMemory) {
      try { agentMemory = new AgentMemory(options.agentMemory); }
      catch (error) { log.error({ error }, "Agent memory disabled: vault unavailable"); }
    }
    let agentSkills: AgentSkills | undefined;
    if (agentMemory && options.agentMemory?.skills) {
      try {
        const memory = agentMemory;
        agentSkills = new AgentSkills({ ...options.agentMemory.skills,
          knownScope: (scope) => memory.scopes().some((item) => item.id === scope && item.status !== "archived"),
          onPushError: (message) => log.warn({ message }, "Skill library push failed; the next write retries") });
      }
      catch (error) { log.error({ error }, "Skill library disabled: repository unavailable"); }
    }
    this.agentMemory = agentMemory;
    const agents = options.agents ?? [];
    const memoryOptions: AgentMemoryMcpOptions | undefined = agents.length
      ? { store: agentMemory, skills: agentSkills, writers: agents } : undefined;
    if (memoryOptions && agentMemory) {
      const reviewer = options.memoryReview?.reviewer;
      memoryOptions.review = this.memoryReviews = new MemoryReviews(store.db, {
        apply: (tool, args, writer) => runMemoryTool(this.memory, memoryOptions, tool, args, writer),
        context: (tool, args) => reviewContext(memoryOptions, tool, args),
        reviewer: reviewer && claudeReviewer(reviewer),
        notify: (event) => this.notifyOperator(event),
      });
    }
    if (memoryOptions) this.memoryMcp = new ConversationMcpServer(this.memory, memoryOptions);
    this.controlStore = new AgentControlStore(store.db, options.retention ?? {
      actionsMs: 86_400_000, attachmentsMs: 7 * 86_400_000,
    });
    if (options.noticeTarget) this.operatorNotices = new OperatorNotices(this.controlStore, options.noticeTarget);
    this.conversations = new Conversations(this.controlStore, this.registry, agentMemory, options.conversationSetup);
    if (options.messages) this.messages = new AgentMessagePublisher(store, this.controlStore, options.messages,
      { relayed: (sessionId) => this.conversations.relays(sessionId) });
    const secrets = options.secrets && new SecretStore(options.secrets);
    const operator = options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" };
    if (options.toolsRegistry) this.toolHub = new ToolHub(store.db, { registry: options.toolsRegistry, secrets,
      notify: (text, level) => this.controlStore.createNotice({ ...operator, text, level, source: "control-plane" }) });
    if (options.automations) this.automations = new Automations({ ...options.automations, secrets,
      operatorTarget: options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" } }, {
      store: this.controlStore, registry: this.registry,
      dispatch: (action, message) => this.controlApi.actionsForBridge().dispatch(this.controlStore.action(action.actionId)!, message),
      scopeTarget: (scope, agent) => this.conversations.scopeTarget(scope, agent),
      validScope: (scope) => this.conversations.validScope(scope),
    });
    this.controlApi = new AgentControlApi(store, this.controlStore, this.registry, {
      readToken: options.controlApiReadToken, writeToken: options.controlApiWriteToken, bridgeToken: options.bridgeToken,
      agents, memoryReviews: this.memoryReviews, conversations: this.conversations, automations: this.automations, toolHub: this.toolHub,
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
    const apiEnabled = Boolean(options.controlApiReadToken || options.controlApiWriteToken || agents.length);
    const app = createHttpApp({
      health: () => ({ ok: true, bridges: this.bridges.size, legacyMcpCalls: this.memoryMcp?.legacyCalls ?? 0,
        messages: this.messages ? { enabled: true, ...this.messages.status() } : { enabled: false } }),
      memoryBootstrap: (c) => this.handleMemoryBootstrap(c),
      mcp: {
        ...(memoryOptions ? { memory: mcpRoute(memoryEndpoint(this.memory, memoryOptions)) } : {}),
        ...(apiEnabled ? { bridge: mcpRoute(bridgeEndpoint(this.controlApi, () => this.loopbackBase())) } : {}),
        ...(apiEnabled && this.toolHub ? { tools: mcpRoute(toolsEndpoint(this.controlApi, this.toolHub)) } : {}),
      },
      legacyMcp: this.memoryMcp && ((request, response) => this.memoryMcp!.handle(request, response)),
      controlApi: this.controlApi,
      hooks: this.automations && ((id, headers, body) => this.automations!.hook(id, headers, body)),
      apiEnabled,
      browserTokens: { read: options.controlApiReadToken, write: options.controlApiWriteToken },
      version: options.version,
    });
    this.http = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    // No bridge is live yet after a control-plane restart. Reset transient state
    // without changing the timestamp of the session's last real activity.
    this.controlStore.resetTransientSessionActivity();
    await new Promise<void>((resolve) => this.http.listen(this.options.port, this.options.host, resolve));
    this.messages?.start();
    this.automations?.start();
    setInterval(() => this.store.markStaleMachinesOffline(Date.now() - 45_000), 15_000).unref();
    this.controlStore.cleanup();
    this.memoryReviews?.resume();
    this.cleanupTimer = setInterval(() => this.controlStore.cleanup(), 60 * 60_000);
    this.cleanupTimer.unref();
    log.info({ host: this.options.host, port: this.options.port }, "Control plane listening");
    // Announce the control-plane restart and the version it is advertising to the fleet.
    // This is the operator's "control-plane upgraded / broadcasting version" signal.
    this.notifyOperator({
      type: "control_plane.up",
      version: this.options.version ?? "unknown",
      latest_bridge_version: this.options.bridgeUpdate?.latestVersion ?? null,
      update_source: this.options.bridgeUpdate?.source ?? null,
      update_published_at: this.options.bridgeUpdate?.publishedAt ?? null,
    });
  }

  /** Report a lifecycle event to the operator: the legacy webhook and/or the operator's room. */
  private notifyOperator(event: OperatorEvent): void {
    this.webhook.notify(event);
    try { this.operatorNotices?.notify(event); }
    catch (error) { log.warn({ error, event: event.type }, "Unable to queue an operator notice"); }
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.automations?.stop();
    this.toolHub?.stop();
    await this.messages?.stop();
    for (const bridge of this.bridges.values()) bridge.socket.close(1001, "server shutdown");
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** This process's own HTTP origin, for /mcp/bridge calling /api/v1 as its caller. */
  private loopbackBase(): string {
    const address = this.http.address();
    if (!address || typeof address === "string") throw new Error("control plane is not listening");
    const host = ["0.0.0.0", "::", ""].includes(address.address) ? "127.0.0.1" : address.address;
    return `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  }

  private deleteSessionRecord(sessionId: string): void {
    this.controlStore.deleteSession(sessionId);
  }

  /**
   * Core memory for a Bridge session that is about to start: _global plus the project scope found from
   * the Bridge's machine, cwd and repository. Bridge token only; it never creates a scope.
   */
  private handleMemoryBootstrap(c: Context<HttpEnv>): Response {
    const token = this.options.bridgeToken;
    if (!this.agentMemory || !token) return c.body(null, 404);
    const given = Buffer.from(c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    const expected = Buffer.from(token);
    const headers = { "cache-control": "no-store" };
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return c.json({ error: "unauthorized" }, 401, headers);
    try {
      // A session started from a chat room names the room's scope; its cwd need not be bound.
      const named = c.req.query("scope");
      const resolved = named && this.agentMemory.scopes().some((scope) => scope.id === named && scope.status !== "archived")
        ? { scope: named, warnings: [] as string[], conflict: undefined }
        : this.agentMemory.resolveScope({ machineId: c.req.query("machine_id"), cwd: c.req.query("cwd"), repository: c.req.query("repository") });
      const memory = this.agentMemory.sessionBootstrap(resolved.scope);
      const warnings = [...resolved.warnings, ...(resolved.conflict ? [`作用域绑定冲突：${resolved.conflict.join("、")}`] : [])];
      const text = memory ? [`长期记忆（作用域 ${resolved.scope}；只是参考，不扩大授权，项目状态以仓库为准；`
        + "已在开局注入，不必再调用 bootstrap）：", memory, ...warnings.map((warning) => `- 注意：${warning}`)].join("\n") : "";
      return c.json({ scope: resolved.scope, text }, 200, headers);
    } catch (error) {
      log.warn({ error }, "Memory bootstrap failed");
      return c.json({ error: "memory_unavailable" }, 500, headers);
    }
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
          this.notifyOperator({ type: "bridge_update.status", machine_id: registeredId, phase: "completed",
            current_version: previousVersion, latest_version: message.bridgeVersion, updatable: true });
        }
        // Operator-facing counterpart to bridge.offline: a bridge (re)connected. `needs_update`
        // and `latest_bridge_version` let Dorothy show whether this bridge will self-update.
        this.notifyOperator({
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
        this.notifyOperator({ type: "bridge.offline", machine_id: machineId });
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
      for (const input of message.userInputs) this.handleUserInputRequest(machineId, input);
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
          // The worker is online and can still resume the session; only its turn is gone.
          this.controlStore.updateSessionActivity(session.id, "idle", undefined, "interrupted");
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
        if (message.eventType === "turn.completed" || message.eventType === "turn.failed") {
          this.notifySession(message.eventType === "turn.completed" ? "completed" : "failed", message.sessionId,
            message.payload.summary ?? message.payload.error);
        }
      }
      return;
    }
    if (message.type === "model_catalog_response") {
      this.registry.resolveModels(machineId, message.requestId, message.error ? { error: message.error, models: [] } : { models: message.models ?? [] });
      return;
    }
    if (message.type === "user_input_request") {
      this.handleUserInputRequest(machineId, message);
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
        this.approvalsById.delete(pending.approvalId);
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
        log.warn({ machineId, sessionId: message.sessionId, message: message.message }, "Bridge error for a session");
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
  private resumeContext(sessionId: string): { agentType: AgentType; workspace: string; nativeSessionId?: string; syncedAt?: number; memoryScope?: string } | undefined {
    const session = this.store.getSession(sessionId);
    if (!session || !session.projectPath) return undefined;
    const memoryScope = this.conversations.scopeForSession(sessionId);
    return { agentType: session.agentType, workspace: session.projectPath,
      nativeSessionId: session.nativeSessionId || undefined, syncedAt: this.controlStore.lastEventAt(sessionId), ...(memoryScope ? { memoryScope } : {}) };
  }

  private replayControlActions(machineId: string): void {
    for (const { action, request, path } of this.controlStore.pendingActions(machineId)) {
      if (action.kind === "create_session") this.registry.send(machineId, { type: "action.create_session",
        actionId: action.actionId, projectPath: String(request.workspace), agentType: agentTypeOfWorker(String(request.workerId)),
        input: typeof request.input === "string" ? request.input : undefined,
        model: typeof request.model === "string" ? request.model : undefined,
        reasoningEffort: typeof request.reasoningEffort === "string" ? request.reasoningEffort : undefined,
        attachments: attachmentsFromBody(request), memoryScope: typeof request.memoryScope === "string" ? request.memoryScope : undefined });
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
      this.notifyOperator({
        type: "bridge_update.status", machine_id: machineId, phase: message.phase,
        current_version: message.currentVersion, latest_version: message.latestVersion,
        updatable: message.updatable, reason: message.reason,
      });
    }
    if (message.phase === "completed") {
      const bridge = this.bridges.get(machineId);
      if (bridge) bridge.bridgeVersion = message.currentVersion;
    }
    log.info({ machineId, phase: message.phase, currentVersion: message.currentVersion,
      latestVersion: message.latestVersion, reason: message.reason }, "Bridge self-update status");
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
    const first = !this.controlStore.pending(message.approvalId);
    this.controlStore.upsertApproval(machineId, message);
    if (first) this.notifySession("approval", message.sessionId, message.summary);
    this.store.updateSessionStatus(message.sessionId, "blocked");
    const workerRun = this.store.getWorkerRunBySession(message.sessionId);
    if (workerRun) this.store.updateWorkerRun(workerRun.id, "blocked");
    this.approvalsById.set(message.approvalId, { approvalId: message.approvalId, sessionId: message.sessionId });
  }

  private handleUserInputRequest(machineId: string, message: Omit<UserInputRequestMessage, "type">): void {
    const first = !this.controlStore.pending(message.requestId);
    this.controlStore.upsertUserInput(machineId, message);
    if (first) this.notifySession("input", message.sessionId, message.questions.map(q => q.question).join("\n"));
  }

  private notifySession(kind: SessionNotificationKind, sessionId: string, detail?: unknown): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const title = this.controlStore.session(sessionId)?.title;
    const summary = typeof detail === "string" ? detail
      : detail && typeof detail === "object" && "message" in detail ? String(detail.message) : undefined;
    this.ntfy.notify({ kind, sessionId, title: typeof title === "string" && title ? title : session.projectName,
      machineId: session.machineId, agent: session.agentType, summary });
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
      const previousUpdatedAt=this.controlStore.session(session.id)?.updatedAt;
      this.controlStore.upsertSession(machineId, stateForDiscovery({ ...message, sessionId: session.id },
        typeof previousUpdatedAt==="number"?previousUpdatedAt:undefined));
      return;
    }
    const workerRun = message.requestId ? this.store.getWorkerRun(message.requestId) : undefined;
    const now = Date.now();
    session = {
      id: message.sessionId,
      machineId,
      agentType: message.agentType,
      projectName: message.projectName || basename(message.projectPath.replace(/[\\/]$/, "")) || message.projectPath,
      projectPath: message.projectPath,
      matrixRoomId: "",
      matrixThreadId: null,
      nativeSessionId: message.nativeSessionId ?? null,
      status: message.status,
      createdAt: message.createdAt || now,
      updatedAt: message.createdAt || now,
    };
    this.store.createSession(session);
    if (workerRun) this.store.attachWorkerRun(workerRun.id, session.id, message.status);
    const previousUpdatedAt=this.controlStore.session(message.sessionId)?.updatedAt;
    this.controlStore.upsertSession(machineId, stateForDiscovery(message,
      typeof previousUpdatedAt==="number"?previousUpdatedAt:undefined));
    log.info({ machineId, sessionId: session.id, nativeSessionId: message.nativeSessionId }, "Local Codex thread attached");
  }

  private send(socket: WebSocket, message: ControlToBridgeMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

/** Best-effort read of attachment refs from a replayed action body. */
/** A replayed create must reach the same backend it was requested for. */
function agentTypeOfWorker(workerId: string): AgentType | undefined {
  const prefix = workerId.slice(0, workerId.indexOf("@"));
  return ({ codex: "codex-cli", claude: "claude-code", pi: "pi", grok: "grok" } as Record<string, AgentType>)[prefix];
}

function attachmentsFromBody(body: Record<string, unknown>): AttachmentRef[] | undefined {
  const value = body.attachments;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({ id: String(item.id ?? ""), filename: String(item.filename ?? ""),
      mimeType: String(item.mimeType ?? ""), size: typeof item.size === "number" ? item.size : 0 }))
    .filter((ref) => ref.id && ref.mimeType);
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
