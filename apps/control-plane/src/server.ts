import { Conversations } from "./conversations.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Context } from "hono";
import { getRequestListener } from "@hono/node-server";
import { basename, join } from "node:path";
import type { Duplex } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { AgentControlStore, ConversationMemoryStore, setRedactedSecrets, Store, type PendingRow } from "@agent-bridge/database";
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
import { approvalReviewer, automationReviewer, learnRule, titleSession, ToolHub, toolReviewer, type ApprovalReviewer, type ToolReviewer } from "./tools.js";
import { reviewModel } from "./review-model.js";
import { transcriber, type TranscribeOptions } from "./transcribe.js";
import { alreadyGated, ApprovalLessons, boundary, remoteTargets, toolOf, type ApprovalAnalysis } from "./approval-review.js";
import { toolsEndpoint } from "./mcp/tools.js";
import { NtfyNotifier, type NtfyOptions, type SessionNotificationKind } from "./ntfy.js";
import { AgentMessagePublisher, type MessageMqttOptions } from "./message-publisher.js";
import { EventBus, type EventBusOptions } from "./event-bus.js";
import { AgentMemory, AgentSkills, type Writer } from "@agent-bridge/agent-memory";
import { ConversationMcpServer } from "./memory-mcp.js";
import { memoryEndpoint, reviewContext, runMemoryTool, type AgentMemoryMcpOptions } from "./mcp/memory.js";
import { memoryReviewer, MemoryReviews } from "./memory-review.js";
import { mcpRoute } from "./mcp/route.js";
import { bridgeEndpoint } from "./mcp/bridge.js";
import { SessionContacts } from "./mcp/contacts.js";
import { CallNotices } from "./call-notices.js";
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
/** The Bridge heartbeats every 15 s: it may have gone away up to two beats after it was last heard of. */
const BACKFILL_MARGIN_MS = 30_000;
/** A turn a Bridge restart cut off is continued after this, unless someone continued the session first (a post-deploy turn, the user). */
const RESUME_DELAY_MS = 20_000;
/** Only turns active this recently are continued: an older "active" turn was more likely stuck than working. */
const RESUME_RECENT_MS = 30 * 60_000;
const RESUME_INPUT = "[Agent Bridge 自动续跑] 你上一轮被 Bridge 重启（更新或崩溃）打断了，接着把它做完。"
  + "重做任何对外操作（提交、推送、发消息、调用会改东西的接口、部署）之前，先查清它是不是已经做过：看 git 状态和历史、工作目录、远端和相关服务的现状。"
  + "做完照常汇报；如果上一轮其实已经完成，简短说明即可。";

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
  /** Bridge lifecycle (online, offline, updates) when it has its own room. */
  private fleetNotices?: OperatorNotices;
  private readonly automations?: Automations;
  private readonly toolHub?: ToolHub;
  private readonly secrets?: SecretStore;
  private readonly toolReviewer?: ToolReviewer;
  /** Notices addressed `call:<who>`: call-bridge rings and reads them out. */
  private calls?: CallNotices;
  private approvalReviewer?: ApprovalReviewer;
  private learnRule?: (summary: string, what: string, where: string) => Promise<string>;
  private approvalLessons?: ApprovalLessons;
  /** Names a session whose agent does not (Codex via app-server, Pi); absent without the reviewer model. */
  private titler?: (prompts: string[], replies: string[]) => Promise<string>;
  private readonly titling = new Set<string>();
  /** The reviewer's explanation of approvals it handed to the human, kept across Bridge replays. */
  private readonly approvalAnalyses = new Map<string, ApprovalAnalysis>();
  private readonly ntfy: NtfyNotifier;
  private readonly messages?: AgentMessagePublisher;
  private readonly events?: EventBus;
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
      /** The one reviewer model; `off` for a kind sends all of that kind to the human. Needs `secrets`. */
      review?: { model: string; fallback?: string; timeoutMs: number; memory: boolean; tools: boolean };
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
      /** Where workers going online/offline and Bridge updates go instead, e.g. an ops room. */
      fleetNoticeTarget?: NoticeTarget;
      /** Schedules and webhooks; failures and proposals go to `noticeTarget`, else the App. */
      automations?: Omit<AutomationOptions, "operatorTarget">;
      secrets?: SecretStoreOptions;
      /** Speech to text for voice messages; TokensAPI needs `secrets`. */
      transcribe?: Omit<TranscribeOptions, "secrets">;
      /** The central tool registry (YAML), served at /mcp/tools. */
      toolsRegistry?: string;
      ntfy?: NtfyOptions;
      messages?: MessageMqttOptions;
      events?: EventBusOptions;
    },
  ) {
    this.webhook = new WebhookNotifier(options.webhook);
    this.ntfy = new NtfyNotifier(options.ntfy);
    const secrets = this.secrets = options.secrets && new SecretStore(options.secrets);
    const model = secrets && options.review ? reviewModel({ secrets, ...options.review }) : undefined;
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
      memoryOptions.review = this.memoryReviews = new MemoryReviews(store.db, {
        apply: (tool, args, writer) => runMemoryTool(this.memory, memoryOptions, tool, args, writer),
        context: (tool, args) => reviewContext(memoryOptions, tool, args),
        reviewer: model && options.review?.memory ? memoryReviewer(model) : undefined,
        notify: (event) => this.notifyOperator(event),
      });
    }
    if (memoryOptions) memoryOptions.onScopeRenamed = (from, to, by) => {
      try { this.automations?.renameScope(from, to, by); } catch (error) { log.warn({ error, from, to }, "Automations did not follow a scope rename"); }
    };
    if (memoryOptions) this.memoryMcp = new ConversationMcpServer(this.memory, memoryOptions);
    this.controlStore = new AgentControlStore(store.db, options.retention ?? {
      actionsMs: 86_400_000, attachmentsMs: 7 * 86_400_000,
    });
    if (options.noticeTarget) this.operatorNotices = new OperatorNotices(this.controlStore, options.noticeTarget);
    if (options.fleetNoticeTarget) this.fleetNotices = new OperatorNotices(this.controlStore, options.fleetNoticeTarget);
    this.conversations = new Conversations(this.controlStore, this.registry, agentMemory, options.conversationSetup);
    this.controlStore.relayRoom = (sessionId) => this.conversations.relayRoom(sessionId);
    if (options.messages) this.messages = new AgentMessagePublisher(store, this.controlStore, options.messages,
      { relayed: (sessionId) => this.conversations.relays(sessionId) });
    const operator = options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" };
    const tools = this.toolReviewer = model && options.review?.tools ? toolReviewer(model) : undefined;
    if (tools && model) {
      this.approvalReviewer = approvalReviewer(model);
      this.learnRule = (summary, what, where) => learnRule(model, summary, what, where);
      this.titler = (prompts, replies) => titleSession(model, prompts, replies);
      if (agentSkills && options.agentMemory?.skills) {
        const skills = agentSkills, repo = options.agentMemory.skills.repo;
        this.approvalLessons = new ApprovalLessons({ file: join(repo, "scopes/_global/agent-bridge/approval-review/references/learned.md"),
          save: (content) => { skills.write({ name: "control-plane", role: "agent" }, { scope: "_global", name: "approval-review", category: "agent-bridge",
            file: "references/learned.md", content }); } });
      }
    }
    if (options.toolsRegistry) this.toolHub = new ToolHub(store.db, { registry: options.toolsRegistry, secrets, reviewer: tools,
      notify: (text, level) => this.controlStore.createNotice({ ...operator, text, level, source: "control-plane" }) });
    const hub = this.toolHub;
    if (hub) this.calls = new CallNotices(this.controlStore, (args) => hub.call("call-bridge.call_place", args, "control-plane"),
      (text) => this.controlStore.createNotice({ ...operator, text, level: "alert", source: "control-plane" }));
    if (options.automations) this.automations = new Automations({ ...options.automations, secrets,
      reviewer: model && options.review?.tools ? automationReviewer(model) : undefined,
      operatorTarget: options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" } }, {
      store: this.controlStore, registry: this.registry,
      dispatch: (action, message) => this.controlApi.actionsForBridge().dispatch(this.controlStore.action(action.actionId)!, message),
      scopeTarget: (scope, agent) => this.conversations.scopeTarget(scope, agent),
      validScope: (scope) => this.conversations.validScope(scope),
      sendTurn: (sessionId, input, key) => this.automationTurn(sessionId, input, key),
      roomTurn: (target, input, key) => this.roomTurn(target, input, key),
    });
    const automations = this.automations;
    if (options.events && (options.events.hookSources.length || (options.events.mqtt && options.events.sources.length)))
      this.events = new EventBus(options.events, {
        db: this.controlStore.db,
        dispatch: (event) => automations?.onEvent(event) ?? true,
        stale: (source, stale, expiresAt) => automations?.onStale(source, stale, expiresAt),
        relay: this.messages && ((event) => this.messages!.relay(event)),
        announce: (text, level) => this.controlStore.createNotice({ ...operator, text, level, source: "event-bus" }),
      });
    this.controlApi = new AgentControlApi(store, this.controlStore, this.registry, {
      readToken: options.controlApiReadToken, writeToken: options.controlApiWriteToken, bridgeToken: options.bridgeToken,
      agents, memoryReviews: this.memoryReviews, conversations: this.conversations, automations: this.automations, toolHub: this.toolHub,
      transcribe: options.transcribe && (secrets || options.transcribe.fallbackUrl) ? transcriber({ ...options.transcribe, secrets }) : undefined,
      onAllowSimilar: (pending, by) => this.learnFrom(pending, by),
      onTrustSession: (pending) => this.allowWaiting(pending.sessionId, pending.id),
      callees: async () => {
        const tool = (await this.toolHub?.search("call_place", 3))?.tools.find((item) => item.name === "call-bridge.call_place");
        const to = (tool?.inputSchema as { properties?: { to?: { enum?: unknown[] } } } | undefined)?.properties?.to?.enum;
        return Array.isArray(to) ? to.map(String) : [];
      },
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
        messages: this.messages ? { enabled: true, ...this.messages.status() } : { enabled: false },
        events: this.events ? { enabled: true, ...this.events.status() } : { enabled: false } }),
      memoryBootstrap: (c) => this.handleMemoryBootstrap(c),
      mcp: {
        ...(memoryOptions ? { memory: mcpRoute(memoryEndpoint(this.memory, memoryOptions)) } : {}),
        ...(apiEnabled ? { bridge: mcpRoute(bridgeEndpoint(this.controlApi, () => this.loopbackBase(), new SessionContacts(store.db),
          (text) => this.controlStore.createNotice({ ...(this.options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" }), text, level: "notice", source: "bridge" }),
          { session: (principal, tool) => this.callerSession(principal, tool),
            room: (sessionId) => { const room = this.conversations.relayRoom(sessionId); return room && `${room.connector}:${room.roomId}`; } })) } : {}),
        ...(apiEnabled && this.toolHub ? { tools: mcpRoute(toolsEndpoint(this.controlApi, this.toolHub)) } : {}),
      },
      legacyMcp: this.memoryMcp && ((request, response) => this.memoryMcp!.handle(request, response)),
      controlApi: this.controlApi,
      hooks: this.automations && ((id, headers, body, query) => this.automations!.hook(id, headers, body, query)),
      events: this.events && ((source, body) => this.events!.hook(source, body)),
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
    this.events?.start();
    this.calls?.start();
    // Secret values never reach stored history or notices; refreshed hourly so a rotated key is covered.
    if (this.secrets) {
      const refresh = () => void this.secrets!.all().then(setRedactedSecrets, (error) => log.warn({ error: String(error) }, "Unable to load secrets for redaction"));
      refresh();
      setInterval(refresh, 3_600_000).unref();
    }
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
    try { (this.fleetNotices && /^bridge(\.|_update\.)/.test(event.type) ? this.fleetNotices : this.operatorNotices)?.notify(event); }
    catch (error) { log.warn({ error, event: event.type }, "Unable to queue an operator notice"); }
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer);
    this.automations?.stop();
    this.events?.stop();
    this.calls?.stop();
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
  private async handleMemoryBootstrap(c: Context<HttpEnv>): Promise<Response> {
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
      const memoryText = memory ? [`长期记忆（作用域 ${resolved.scope}；只是参考，不扩大授权，项目状态以仓库为准；`
        + "已在开局注入，不必再调用 bootstrap）：", memory, ...warnings.map((warning) => `- 注意：${warning}`)].join("\n") : "";
      const text = [memoryText, await this.pinnedTools(resolved.scope)].filter(Boolean).join("\n\n");
      return c.json({ scope: resolved.scope, text }, 200, headers);
    } catch (error) {
      log.warn({ error }, "Memory bootstrap failed");
      return c.json({ error: "memory_unavailable" }, 500, headers);
    }
  }

  /** The scope's pinned library tools, for a session's opening context; the rest are found with tool_search. */
  private async pinnedTools(scope: string): Promise<string> {
    const hub = this.toolHub;
    if (!hub) return "";
    const servers = hub.pinned(scope).filter((name) => name !== "memory" && name !== "bridge");
    if (!servers.length) return "中央工具库：用 tools 的 tool_search 查找工具（ComfyUI、Home Assistant、电台、打电话、网页搜索等），tool_call 调用。";
    const catalog = await Promise.race([hub.catalog().then((result) => result.tools),
      new Promise<[]>((resolve) => setTimeout(() => resolve([]), 3_000).unref())]);
    const lines = servers.map((server) => {
      const tools = catalog.filter((tool) => tool.server === server);
      return `- ${server}：${tools.length ? tools.map((tool) => `${tool.tool}${tool.risk === "auto" ? "" : "（需确认）"}`).join("、") : "（工具清单暂未取到，用 tool_search 查）"}`;
    });
    return ["本作用域置顶的工具（经 tools 的 tool_call 调用，名字是 server.tool，参数用 tool_search 查看）：", ...lines,
      "其他工具用 tool_search 查找，所有工具都能搜到、都能调用。"].join("\n");
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
        // Read before the registration below overwrites it: the Bridge was last heard of here.
        const lastSeen = (this.store.db.prepare("SELECT last_seen_at FROM machines WHERE id=?").get(registeredId) as { last_seen_at: number } | undefined)?.last_seen_at;
        this.bridges.set(registeredId, {
          backfillSince: message.features?.includes("history-backfill") ? (lastSeen ? Math.max(0, lastSeen - BACKFILL_MARGIN_MS) : 0) : undefined,
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
          if (session.active_turn_id) this.resumeInterrupted(session.id, machineId, session.active_turn_id);
        }
        this.reclaimOrphanedRuns(machineId, present);
        this.backfillOffline(machineId, message.sessions);
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
      // An approval the reviewer answered says so, with what it let through: the session shows that instead of the bare outcome.
      const review = message.eventType === "approval.resolved" && typeof message.payload.approvalId === "string"
        ? this.controlStore.approvalReview(message.payload.approvalId) : undefined;
      if (review) message = { ...message, payload: { ...message.payload, review } };
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
        if (message.eventType === "turn.completed") this.giveTitle(message.sessionId);
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
      const answering = message.status === "failed" ? this.store.db.prepare("SELECT id FROM pending_requests WHERE resolving_action_id=?")
        .get(message.actionId) as { id: string } | undefined : undefined;
      this.controlApi.actionsForBridge().complete(message);
      if (message.status === "failed") this.dropDeadPending(message, answering?.id);
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

  /**
   * Continue a turn a Bridge restart cut off, once (docs/agent-control-api.md §13): after a pause, and only
   * if nothing continued the session meanwhile and the turn was working recently. RESUME_INTERRUPTED=off turns it off.
   */
  private resumeInterrupted(sessionId: string, machineId: string, turnId: string): void {
    if (process.env.RESUME_INTERRUPTED === "off") return;
    const cutAt = Date.now();
    // The turn's own last sign of work, not the interruption just recorded for it.
    const lastActive = Number((this.store.db.prepare("SELECT MAX(created_at) AS at FROM events WHERE session_id=? AND type<>'turn.interrupted'")
      .get(sessionId) as { at: number | null }).at ?? 0);
    if (cutAt - lastActive > RESUME_RECENT_MS) return;
    const timer = setTimeout(() => {
      try {
        const session = this.store.db.prepare("SELECT active_turn_id FROM sessions WHERE id=?").get(sessionId) as { active_turn_id: string | null } | undefined;
        if (!session || session.active_turn_id) return;
        // Another turn begun since the cut one started continued the session, even one begun before the restarted
        // Bridge's inventory marked the cut (a post-deploy turn arrives at registration, ahead of it).
        const began = Number((this.store.db.prepare("SELECT MIN(created_at) AS at FROM events WHERE session_id=? AND turn_id=? AND type='turn.started'")
          .get(sessionId, turnId) as { at: number | null }).at ?? cutAt);
        const later = this.store.db.prepare("SELECT 1 FROM events WHERE session_id=? AND type='turn.started' AND turn_id<>? AND created_at>=? LIMIT 1").get(sessionId, turnId, began);
        const asking = this.store.db.prepare("SELECT 1 FROM pending_requests WHERE session_id=? AND status='pending' LIMIT 1").get(sessionId);
        // Its own record of submitted turns is the surer sign: a restarted Bridge's events may lag behind or be lost.
        const submitted = this.store.db.prepare("SELECT 1 FROM actions WHERE session_id=? AND kind='submit_turn' AND principal<>'system:resume' AND created_at>=? LIMIT 1")
          .get(sessionId, began);
        if (later || submitted || asking || this.postDeploy.waitsFor(sessionId)) return;
        const created = this.controlStore.createAction({ principal: "system:resume", key: `resume:${sessionId}:${turnId}`, method: "POST",
          path: `/api/v1/sessions/${sessionId}/turns`, body: { input: RESUME_INPUT, delivery: "auto" }, kind: "submit_turn", machineId, sessionId });
        if (created.existing) return;
        log.info({ sessionId, turnId }, "Continuing a turn a Bridge restart cut off");
        this.controlApi.actionsForBridge().dispatch(created.action, { type: "action.submit_turn", actionId: created.action.actionId,
          sessionId, input: RESUME_INPUT, delivery: "auto", resume: this.resumeContext(sessionId) });
      } catch (error) { log.warn({ error, sessionId }, "Unable to continue an interrupted turn"); }
    }, RESUME_DELAY_MS);
    timer.unref();
  }

  /**
   * After a reconnect, only the sessions that changed while the Bridge was away get their history, and only
   * from then on (docs/agent-control-api.md §14): a plain restart compares one timestamp per session and
   * resends nothing. A machine never seen gets its recent sessions' history once.
   */
  private backfillOffline(machineId: string, sessions: Array<{ sessionId: string; updatedAt?: number }>): void {
    const bridge = this.bridges.get(machineId);
    if (!bridge || bridge.backfillSince === undefined) return;
    const since = bridge.backfillSince;
    bridge.backfillSince = undefined;
    const changed = since === 0
      ? [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 100)
      : sessions.filter((session) => (session.updatedAt ?? 0) > since);
    for (const session of changed) this.send(bridge.socket, { type: "history.backfill", sessionId: session.sessionId, since });
    if (changed.length) log.info({ machineId, since, sessions: changed.length }, "Backfilling the sessions that changed while the Bridge was offline");
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

  /**
   * The session an agent's MCP call comes from. The token names the agent and its machine (`codex@dev-windows`),
   * not the session; but the session's Bridge reports the tool call as it starts, so the one session of that machine
   * calling `tool` right now is the caller. Several, or none within a second, is unknown.
   */
  private async callerSession(principal: string, tool: string): Promise<string | undefined> {
    const name = principal.replace(/^agent:/, ""), at = name.indexOf("@");
    if (at < 1) return undefined;
    const machine = name.slice(at + 1), since = Date.now() - 30_000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = this.store.db.prepare(`SELECT DISTINCT e.session_id AS id FROM events e JOIN sessions s ON s.id=e.session_id
        WHERE s.machine_id=? AND e.type='tool.started' AND e.created_at>? AND json_extract(e.body,'$.name') IN (?,?)`)
        .all(machine, since, tool, `mcp__bridge__${tool}`) as Array<{ id: string }>;
      if (rows.length === 1) return rows[0]!.id;
      if (rows.length > 1) return undefined;
      await new Promise((wake) => setTimeout(wake, 200));
    }
    return undefined;
  }

  /** A turn an automation sends a session: steers it when busy, revives it when its Bridge no longer holds it. */
  private automationTurn(sessionId: string, input: string, key: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error("会话不存在（可能已删除）");
    if (!this.registry.get(session.machineId)) throw new Error(`${session.machineId} 不在线`);
    const created = this.controlStore.createAction({ principal: "system:automations", key, method: "POST", path: `/api/v1/sessions/${sessionId}/turns`,
      body: { input, delivery: "auto" }, kind: "submit_turn", machineId: session.machineId, sessionId });
    if (!created.existing) this.controlApi.actionsForBridge().dispatch(created.action, { type: "action.submit_turn", actionId: created.action.actionId,
      sessionId, input, delivery: "auto", resume: this.resumeContext(sessionId) });
  }

  /** A turn to the session a room (or thread) continues; a room without one starts one in its scope and continues it from then on. */
  private async roomTurn(target: NoticeTarget, input: string, key: string): Promise<string> {
    const conversation = this.conversations.get(target.connector, target.roomId, target.threadId);
    if (conversation.sessionId) { this.automationTurn(conversation.sessionId, input, key); return conversation.sessionId; }
    if (!conversation.target || conversation.problem) throw new Error(String(conversation.problem ?? "房间没有可用的工作目录"));
    const { workerId, workspace } = conversation.target, machineId = workerId.slice(workerId.indexOf("@") + 1), agentType = agentTypeOfWorker(workerId);
    if (!agentType) throw new Error(`无效的 worker ${workerId}`);
    if (!this.registry.get(machineId)) throw new Error(`${machineId} 不在线`);
    const memoryScope = conversation.scope?.id;
    const created = this.controlStore.createAction({ principal: "system:automations", key, method: "POST", path: "/api/v1/sessions",
      body: { workerId, workspace, input, ...(memoryScope ? { memoryScope } : {}) }, kind: "create_session", machineId });
    if (!created.existing) this.controlApi.actionsForBridge().dispatch(created.action, { type: "action.create_session", actionId: created.action.actionId,
      agentType, projectPath: workspace, input, ...(memoryScope ? { memoryScope } : {}) });
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; await new Promise((wake) => setTimeout(wake, 1_000))) {
      const action = this.controlStore.action(created.action.actionId);
      if (action?.status === "failed") throw new Error(`会话没有建成：${action.error?.message ?? action.error?.code}`);
      if (action?.status === "succeeded" && action.sessionId) {
        this.conversations.set(target.connector, target.roomId, target.threadId, { sessionId: action.sessionId });
        return action.sessionId;
      }
    }
    throw new Error("会话迟迟没有建成");
  }

  /** A session just trusted: allow what else it is waiting on, as the next ones will be. */
  private allowWaiting(sessionId: string, except: string): void {
    const rows = this.store.db.prepare("SELECT id,machine_id,request_json FROM pending_requests WHERE session_id=? AND kind='approval' AND status='pending' AND id<>?")
      .all(sessionId, except) as Array<{ id: string; machine_id: string; request_json: string }>;
    for (const row of rows) {
      const request = JSON.parse(row.request_json) as ApprovalRequestMessage;
      if (request.choices?.includes("allow")) this.resolveByReview(row.machine_id, { ...request, approvalId: row.id, sessionId }, "allow", "本会话已由你授权全部允许");
    }
  }

  /**
   * Claude names its sessions itself; Codex through the app-server and Pi do not (Pi only repeats the first
   * prompt). After a turn of such a session completes, the reviewer model names it once; the agent's own
   * name, should it give one later, still wins (sessionTitle in the store).
   */
  private giveTitle(sessionId: string): void {
    if (!this.titler || this.titling.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session || session.agentType === "claude-code") return;
    const untitled = this.controlStore.untitled(sessionId);
    if (!untitled) return;
    this.titling.add(sessionId);
    void this.titler(untitled.prompts, untitled.replies)
      .then((title) => { this.controlStore.setAutoTitle(sessionId, title); log.info({ sessionId, title }, "Gave a session a title"); })
      .catch((error) => log.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, "Could not title a session"))
      .finally(() => this.titling.delete(sessionId));
  }

  /** What the boundary needs to know about where a session works: its workspace and the remote targets allowed there. */
  private approvalPlace(sessionId: string): { workspace: string; remotes: string[]; caller: string } {
    const session = this.store.getSession(sessionId), workspace = session?.projectPath ?? "";
    return { workspace, remotes: session ? this.controlStore.approvalRemotes(session.machineId, workspace) : [],
      caller: session ? `${session.agentType}@${session.machineId}:${workspace}` : "" };
  }

  /**
   * “允许类似的操作”: the human (`by`) lets this workspace reach the call's remote targets from now on, and the reviewer
   * turns the call into a rule. Absolute-boundary calls teach nothing.
   */
  private learnFrom(pending: PendingRow, by: string): void {
    const summary = String(pending.request.summary ?? ""), what = String((pending.request.analysis as { what?: string } | undefined)?.what ?? "");
    const tool = toolOf(pending.request.kind, summary), place = this.approvalPlace(pending.sessionId);
    if (boundary({ tool, summary, choices: ["allow"], workspace: place.workspace }) === "absolute") return;
    const operator = this.options.noticeTarget ?? { connector: "app", roomId: "operator", threadId: "" };
    const reached = by.startsWith("control:") && place.workspace ? remoteTargets(summary, place.workspace).filter((target) => !place.remotes.includes(target)) : [];
    for (const target of reached) this.controlStore.setApprovalRemote(pending.machineId, place.workspace, target, by);
    if (reached.length) {
      log.info({ machineId: pending.machineId, workspace: place.workspace, targets: reached, by }, "Workspace may reach remote targets");
      this.controlStore.createNotice({ id: `remote:${pending.id}`, ...operator, level: "silent", source: "review", sessionId: pending.sessionId,
        text: `🔓 ${pending.machineId}:${place.workspace} 以后可以连 ${reached.map((target) => target === "windows" ? "Windows" : target.slice(4)).join("、")}，只按在那边执行的命令审核` });
    }
    if (!this.learnRule || !this.approvalLessons) return;
    const lessons = this.approvalLessons;
    void this.learnRule(summary, what, place.caller).then((rule) => {
      lessons.add(rule, summary);
      log.info({ rule, approvalId: pending.id }, "Reviewer learned a rule from the human");
      this.controlStore.createNotice({ id: `learn:${pending.id}`, ...operator, level: "silent", source: "review", sessionId: pending.sessionId,
        text: `📚 审核员记住了一条规则\n${rule}` });
    }).catch((error) => log.warn({ error: String(error), approvalId: pending.id }, "Could not learn a rule from this approval"));
  }

  /** Answer an approval for the reviewer, as the human would through /api/v1, and say so quietly. */
  /** Answer an approval for the agent. Automatic allows are only logged: the human is told about what needs them (clown 2026-11-02). */
  private resolveByReview(machineId: string, message: ApprovalRequestMessage, choice: "allow" | "deny", reason: string, what = ""): boolean {
    try {
      this.controlStore.recordApprovalReview(message.approvalId, choice, what || approvalHead(message.summary), reason);
      const created = this.controlStore.createAction({ principal: "system:review", key: `review:${message.approvalId}`, method: "POST",
        path: `/api/v1/approvals/${message.approvalId}/decision`, body: { choice }, kind: "resolve_approval", machineId, sessionId: message.sessionId });
      if (!created.existing) this.controlApi.actionsForBridge().dispatch(created.action, { type: "action.resolve_approval", actionId: created.action.actionId,
        sessionId: message.sessionId, approvalId: message.approvalId, choice });
    } catch (error) { log.warn({ error, approvalId: message.approvalId }, "Reviewed approval could not be sent; asking the human"); return false; }
    log.info({ approvalId: message.approvalId, choice, reason, summary: message.summary.slice(0, 200) }, "Approval decided by the reviewer");
    return true;
  }

  /**
   * The Bridge no longer has what an answer was for: the session is gone from it (deleted there) or the request
   * was already settled. Waiting would only fail again on every click, so the request ends as expired; a gone
   * session's other requests end with it. A complete snapshot does the same on reconnect.
   */
  private dropDeadPending(message: { sessionId?: string | null; error?: { message?: string } | null }, pendingId?: string): void {
    const text = message.error?.message ?? "";
    if (message.sessionId && /No adapter owns session/.test(text)) {
      const rows = this.store.db.prepare("SELECT id FROM pending_requests WHERE session_id=? AND status='pending'").all(message.sessionId) as Array<{ id: string }>;
      for (const row of rows) this.controlStore.resolvePending(row.id, "expired");
      if (rows.length) log.info({ sessionId: message.sessionId, expired: rows.length }, "The Bridge no longer has this session; its requests expired");
    } else if (pendingId && /no longer pending/i.test(text)) {
      this.controlStore.resolvePending(pendingId, "expired");
      log.info({ pendingId }, "The Bridge had already settled this request; it expired here");
    }
  }

  private async handleApprovalRequest(machineId: string, message: ApprovalRequestMessage, reviewed = false): Promise<void> {
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
    const place = this.approvalPlace(message.sessionId), remotes = remoteTargets(message.summary, place.workspace);
    // Every first request is reviewed before anyone is asked. Allowed or denied, it never reaches the human;
    // otherwise the human sees it with the reviewer's analysis and may let similar ones through from now on.
    // The human let this session do anything (“本会话全部允许”): nothing it asks reaches anyone.
    if (first && message.choices.includes("allow") && this.controlStore.sessionTrusted(message.sessionId)
      && this.resolveByReview(machineId, message, "allow", "本会话已由你授权全部允许")) return;
    if (first && !reviewed && this.approvalReviewer && message.choices.includes("allow")) {
      const tool = toolOf(message.kind, message.summary);
      if (alreadyGated(tool) && this.resolveByReview(machineId, message, "allow", "中央工具库和记忆的调用由 Control Plane 自己按档位把关，不再重复确认")) return;
      // Answering another session's approval is judged by what that approval asks.
      let answering: string | undefined, level = boundary({ tool, summary: message.summary, choices: message.choices, ...place });
      if (/^mcp__bridge__(approve|answer)$/.test(tool)) {
        const id = /"(?:approval_id|request_id)"\s*:\s*"([^"]+)"/.exec(message.summary)?.[1];
        const pending = id ? this.controlStore.pending(id) : undefined;
        answering = pending ? String(pending.request.summary ?? "") : "";
        const targetTool = toolOf(pending?.request.kind, answering);
        if (pending && alreadyGated(targetTool) && this.resolveByReview(machineId, message, "allow", "被答复的是中央工具库/记忆的调用，本来就免确认")) return;
        const targetLevel = pending ? boundary({ tool: targetTool, summary: answering, choices: (pending.request.choices as string[] | undefined) ?? ["allow"],
          ...this.approvalPlace(pending.sessionId) }) : "absolute";
        if (targetLevel === "absolute" || (targetLevel === "hard" && level !== "absolute")) level = targetLevel;
      }
      // Off the Bridge's message chain: its other events keep flowing while the reviewer thinks.
      this.approvalsById.set(message.approvalId, { approvalId: message.approvalId, sessionId: message.sessionId });
      void this.approvalReviewer({ summary: message.summary, tool, boundary: level, learned: this.approvalLessons?.text() ?? "", answering,
        caller: place.caller, remotes: remotes.map((target) => ({ target, allowed: place.remotes.includes(target) })) })
        .catch((error: unknown) => ({ decision: "human" as const, what: "", risk: "medium" as const, reason: `审核失败：${error instanceof Error ? error.message : String(error)}` }))
        .then((verdict) => {
          if (verdict.decision !== "human" && this.resolveByReview(machineId, message, verdict.decision, verdict.reason, verdict.what)) return;
          log.info({ approvalId: message.approvalId, tool, boundary: level, reason: verdict.reason }, "Reviewer handed an approval to the human");
          if (verdict.what) this.approvalAnalyses.set(message.approvalId, { what: verdict.what, risk: verdict.risk, reason: verdict.reason });
          this.approvalsById.delete(message.approvalId);
          return this.handleApprovalRequest(machineId, message, true);
        }).catch((error) => log.error({ error, approvalId: message.approvalId }, "Approval review failed"));
      return;
    }
    const analysis = this.approvalAnalyses.get(message.approvalId);
    // “Allow similar” is offered only where a rule can be learned: never behind the absolute boundary.
    const reaches = remotes.some((target) => !place.remotes.includes(target));
    const learnable = Boolean((this.approvalLessons || reaches) && message.choices.includes("allow")
      && boundary({ tool: toolOf(message.kind, message.summary), summary: message.summary, choices: message.choices, ...place }) !== "absolute");
    if (analysis || learnable) message = { ...message, ...(analysis ? { analysis } : {}), ...(learnable ? { similar: true } : {}) } as typeof message;
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

/** The first line of what an approval asks, without Codex's “… approval required” heading, for a note that has no reviewer analysis. */
function approvalHead(summary: string): string {
  const line = summary.split("\n").map((part) => part.trim()).find((part) => part && !/approval required$/i.test(part)) ?? summary.trim();
  return line.replace(/^Command:\s*/, "").slice(0, 160);
}
