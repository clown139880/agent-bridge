import pino from "pino";
import WebSocket from "ws";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BRIDGE_PROTOCOL_VERSION,
  parseMessage,
  type ActionResultMessage,
  type AgentType,
  type BridgeToControlMessage,
  type ControlToBridgeMessage,
  type RegisterMessage,
  type SessionState,
} from "@agent-bridge/protocol";
import { CodexAppServerAdapter } from "./app-server.js";
import { config } from "./config.js";
import { ClaudeCodeAdapter } from "./claude/claude-adapter.js";
import { makeAttachmentFetcher } from "./attachments.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { BridgeSelfUpdater } from "./self-updater.js";

const log = pino({ name: "bridge-client" });

/** Map a provider name from config to its canonical AgentType. */
function providerToAgentType(provider: string): AgentType | undefined {
  if (provider === "codex") return "codex-cli";
  if (provider === "claude") return "claude-code";
  return undefined;
}

/** Registration capabilities contributed by each agent type. */
function capabilitiesFor(agentType: AgentType): string[] {
  if (agentType === "claude-code") return ["claude-code", "claude-cli"];
  return ["codex-cli", "codex-app-server"];
}

export class BridgeClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconcileInFlight = false;
  private stopped = false;
  private readonly adapters = new Map<AgentType, AgentAdapter>();
  /** sessionId -> owning agent type, so session-addressed messages route correctly. */
  private readonly sessionOwner = new Map<string, AgentType>();
  private readonly updater: BridgeSelfUpdater;
  private readonly actionResults = new Map<string, ActionResultMessage>();
  private readonly inFlightActions = new Set<string>();
  private readonly queuedStateMessages: BridgeToControlMessage[] = [];
  private registered = false;

  constructor(private readonly options: {
    url: string;
    token?: string;
    machineId: string;
    machineName: string;
    hostname: string;
    platform: NodeJS.Platform;
    providers?: string[];
    command: string;
    appServerUrl: string;
    manageAppServer: boolean;
    desktopHome?: string;
    desktopScanIntervalMs: number;
    desktopReplayExisting: boolean;
    claudeCommand?: string;
    claudeHome?: string;
    claudeScanExisting?: boolean;
    allowedRoots: string[];
    reconnectMs: number;
    version: string;
    updateEnabled: boolean;
    updateSource?: string;
    updateSourceRef: string;
    updateInstallRoot: string;
    updateCurrentLink: string;
    updateStatePath: string;
    actionCachePath: string;
    actionCacheTtlMs: number;
    drainFile?: string;
    updatePackageManager: string;
    updateRestartExecutable: string;
    updateRestartArgs: string[];
  }) {
    this.loadActionResults();

    const providers = options.providers?.length ? options.providers : ["codex"];
    if (providers.includes("codex")) {
      this.adapters.set("codex-cli", new CodexAppServerAdapter({
        command: options.command,
        url: options.appServerUrl,
        allowedRoots: options.allowedRoots,
        manageServer: options.manageAppServer,
        desktopHome: options.desktopHome,
        desktopScanIntervalMs: options.desktopScanIntervalMs,
        desktopReplayExisting: options.desktopReplayExisting,
        fetchAttachment: makeAttachmentFetcher(options.url, options.token),
        reconnectMs: options.reconnectMs,
      }, this.adapterEmit("codex-cli")));
    }
    if (providers.includes("claude")) {
      this.adapters.set("claude-code", new ClaudeCodeAdapter({
        command: options.claudeCommand ?? "claude",
        claudeHome: options.claudeHome ?? `${process.env.HOME ?? ""}/.claude`,
        allowedRoots: options.allowedRoots,
        scanExisting: options.claudeScanExisting ?? false,
        fetchAttachment: makeAttachmentFetcher(options.url, options.token),
      }, this.adapterEmit("claude-code")));
    }
    if (!this.adapters.size) throw new Error(`No known agent providers enabled: ${providers.join(",")}`);

    this.updater = new BridgeSelfUpdater({
      enabled: options.updateEnabled,
      currentVersion: options.version,
      source: options.updateSource,
      sourceRef: options.updateSourceRef,
      installRoot: options.updateInstallRoot,
      sourceCheckout: config.updateSourceCheckout,
      currentLink: options.updateCurrentLink,
      statePath: options.updateStatePath,
      packageManager: options.updatePackageManager,
      storeDir: config.updateStoreDir,
      releaseRetention: config.updateReleaseRetention,
      restartExecutable: options.updateRestartExecutable,
      restartArgs: options.updateRestartArgs,
      isBusy: () => [...this.adapters.values()].some((a) => !a.isReady() || a.hasActiveSessions()),
      report: (message) => this.send(message),
      reportIdle: () => this.send({ type: "bridge.idle", machineId: this.options.machineId, timestamp: Date.now() }),
    });
  }

  /** Build the per-adapter emit callback: tag session ownership, forward, and poke the updater. */
  private adapterEmit(agentType: AgentType): (message: BridgeToControlMessage) => void {
    return (message) => {
      if (message.type === "session.discovered" && "sessionId" in message) {
        this.sessionOwner.set(message.sessionId, agentType);
      }
      if (["session.discovered", "session.event", "approval_request", "approval_resolved",
        "user_input_request", "user_input_resolved"].includes(message.type)) this.sendDurable(message);
      else this.send(message);
      if (message.type === "agent.completed" || message.type === "agent.failed"
        || message.type === "agent.stopped" || message.type === "approval_resolved") {
        queueMicrotask(() => void this.updater.activityChanged());
      }
    };
  }

  /** Adapter that genuinely holds this session in memory (owner map or snapshot scan), else undefined. */
  private ownedBy(sessionId: string): AgentAdapter | undefined {
    const owner = this.sessionOwner.get(sessionId);
    if (owner && this.adapters.has(owner)) return this.adapters.get(owner)!;
    for (const [type, adapter] of this.adapters) {
      if (adapter.isReady() && adapter.stateSnapshot().sessions.some((s) => s.sessionId === sessionId)) {
        this.sessionOwner.set(sessionId, type);
        return adapter;
      }
    }
    return undefined;
  }

  /** Resolve the adapter that owns a session id (falls back to sole adapter, else throws). */
  private adapterForSession(sessionId: string): AgentAdapter {
    const owned = this.ownedBy(sessionId);
    if (owned) return owned;
    if (this.adapters.size === 1) return this.adapters.values().next().value!;
    throw new Error(`No adapter owns session ${sessionId}`);
  }

  /**
   * Resolve the adapter for a submit_turn, reviving the session first if this bridge
   * no longer holds it (e.g. a Claude subprocess killed by a restart/self-update) and
   * the control-plane supplied a resume hint. Without a hint, or an adapter that can't
   * resume, this falls back to the normal resolution (which throws for unknown sessions).
   */
  private async ensureTurnOwner(message: Extract<ControlToBridgeMessage, { type: "action.submit_turn" }>): Promise<AgentAdapter> {
    const owned = this.ownedBy(message.sessionId);
    if (owned) return owned;
    const resume = message.resume;
    const adapter = resume ? this.adapters.get(resume.agentType) : undefined;
    if (resume && adapter?.resumeSession) {
      log.info({ sessionId: message.sessionId, agentType: resume.agentType, workspace: resume.workspace },
        "Reviving session before turn — bridge no longer held it");
      await adapter.resumeSession(message.sessionId, resume.workspace, resume.nativeSessionId, message.model);
      this.sessionOwner.set(message.sessionId, resume.agentType);
      return adapter;
    }
    return this.adapterForSession(message.sessionId);
  }

  /** Resolve the adapter for a target agent type (defaults to the first enabled adapter). */
  private adapterForType(agentType?: AgentType): AgentAdapter {
    if (agentType && this.adapters.has(agentType)) return this.adapters.get(agentType)!;
    return this.adapters.values().next().value!;
  }

  start(): void {
    this.stopped = false;
    for (const [type, adapter] of this.adapters) {
      void adapter.start()
        .then(() => this.updater.activityChanged())
        .catch((error) => {
          log.error({ error, agentType: type }, "Unable to initialize agent adapter");
        });
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    for (const adapter of this.adapters.values()) adapter.stop();
    this.socket?.close(1000, "bridge shutdown");
  }

  /** Merge session-activity buckets across all ready adapters. */
  private aggregateActivity(): { activeSessionIds: string[]; waitingSessionIds: string[]; blockedSessionIds: string[] } {
    const active = new Set<string>();
    const waiting = new Set<string>();
    const blocked = new Set<string>();
    for (const adapter of this.adapters.values()) {
      if (!adapter.isReady()) continue;
      const a = adapter.sessionActivity();
      a.activeSessionIds.forEach((s) => active.add(s));
      a.waitingSessionIds.forEach((s) => waiting.add(s));
      a.blockedSessionIds.forEach((s) => blocked.add(s));
    }
    return { activeSessionIds: [...active], waitingSessionIds: [...waiting], blockedSessionIds: [...blocked] };
  }

  private connect(): void {
    log.info({ url: this.options.url }, "Connecting to control plane");
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.on("open", () => {
      this.registered = false;
      const registration: RegisterMessage = {
        type: "register",
        machineId: this.options.machineId,
        name: this.options.machineName,
        hostname: this.options.hostname,
        platform: this.options.platform,
        capabilities: [
          ...new Set([...this.adapters.keys()].flatMap((type) => capabilitiesFor(type))),
          "local-first", "git",
        ],
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        features: ["session-inventory", "session-events", "session-actions", "turn-steer",
          "turn-interrupt", "approvals", "user-input", "desktop-terminal-history"],
        bridgeVersion: this.options.version,
        token: this.options.token,
      };
      this.send(registration);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 15_000);
    });
    socket.on("message", (data) => {
      const message = parseMessage(data.toString());
      if (message) this.handleMessage(message as unknown as ControlToBridgeMessage);
    });
    socket.on("close", (code, reason) => {
      this.registered = false;
      clearInterval(this.heartbeatTimer);
      log.warn({ code, reason: reason.toString() }, "Disconnected from control plane");
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectMs);
    });
    socket.on("error", (error) => log.warn({ error }, "WebSocket error"));
  }

  private handleMessage(message: ControlToBridgeMessage): void {
    try {
      switch (message.type) {
        case "registered":
          this.registered = true;
          log.info({ machineId: message.machineId }, "Bridge registered");
          void this.updater.recoverAfterRestart().catch((error) => {
            log.error({ error }, "Unable to recover self-update state");
          });
          this.sendStateSnapshot();
          break;
        case "bridge_update.available":
          void this.updater.consider(message).catch((error) => {
            log.error({ error }, "Unable to process bridge update announcement");
          });
          break;
        case "start_agent":
          if (!this.admitNewWork()) {
            this.send({ type: "error", sessionId: message.sessionId, code: "update_required",
              message: this.admissionMessage() });
            break;
          }
          void this.adapterForType(message.agentType).startSession(message.sessionId, message.projectPath, message.prompt, message.resumeSessionId, message.model, message.attachments)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "agent_input":
          if (!this.admitNewWork()) {
            this.send({ type: "error", sessionId: message.sessionId, code: "update_required",
              message: this.admissionMessage() });
            break;
          }
          void this.adapterForSession(message.sessionId).input(message.sessionId, message.text, message.model, message.attachments)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "approval_response":
          void this.adapterForSession(message.sessionId).approve(message.sessionId, message.approvalId, message.choice)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "stop_agent":
          void this.adapterForSession(message.sessionId).stopSession(message.sessionId)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "log_request":
          this.send({ type: "log_response", sessionId: message.sessionId, text: this.adapterForSession(message.sessionId).logs(message.sessionId, message.lines) });
          break;
        case "model_catalog_request":
          void this.adapterForType().models().then(models => this.send({ type: "model_catalog_response", requestId: message.requestId, models }))
            .catch(error => this.send({ type: "model_catalog_response", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) }));
          break;
        case "action.create_session":
        case "action.submit_turn":
        case "action.interrupt_turn":
        case "action.resolve_approval":
        case "action.resolve_user_input":
        case "action.delete_session":
          void this.handleAction(message);
          break;
        case "error":
          log.warn({ message: message.message }, "Control plane error");
          break;
      }
    } catch (error) {
      const sessionId = "sessionId" in message ? message.sessionId : undefined;
      this.send({ type: "error", sessionId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private send(message: BridgeToControlMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private sendStateSnapshot(): void {
    if(this.stopped)return;
    if([...this.adapters.values()].some((a)=>!a.isReady())){setTimeout(()=>this.sendStateSnapshot(),250).unref();return;}
    const sessions:SessionState[]=[];const approvals:Array<Record<string,unknown>>=[];const userInputs:Array<Record<string,unknown>>=[];
    for(const[type,adapter]of this.adapters){
      const snap=adapter.stateSnapshot();
      for(const session of snap.sessions)this.sessionOwner.set(session.sessionId,type);
      sessions.push(...snap.sessions);approvals.push(...snap.approvals);userInputs.push(...snap.userInputs);
    }
    this.send({type:"state.snapshot",generation:`${Date.now()}`,sessions,approvals,userInputs,complete:true} as BridgeToControlMessage);
    while(this.queuedStateMessages.length)this.send(this.queuedStateMessages.shift()!);
  }

  private sendDurable(message:BridgeToControlMessage):void {
    if(this.registered&&this.socket?.readyState===WebSocket.OPEN){this.send(message);return;}
    this.queuedStateMessages.push(message);
    if(this.queuedStateMessages.length>10_000){
      this.queuedStateMessages.shift();
      log.error("Bridge state queue overflow; oldest event will be recovered from App Server history");
    }
  }

  private async handleAction(message: Extract<ControlToBridgeMessage,{type:`action.${string}`}>): Promise<void> {
    const prior=this.actionResults.get(message.actionId);if(prior){
      // A reconnect can replay an action while its original RPC is still in
      // flight in this process. The original completion is sent on the current
      // socket; do not expose the crash-recovery placeholder as a real failure.
      if(!this.inFlightActions.has(message.actionId))this.send(prior);
      return;
    }
    const kind=({"action.create_session":"create_session","action.submit_turn":"submit_turn",
      "action.interrupt_turn":"interrupt_turn","action.resolve_approval":"resolve_approval",
      "action.resolve_user_input":"resolve_user_input","action.delete_session":"delete_session"} as const)[message.type];
    this.actionResults.set(message.actionId,{type:"action.result",actionId:message.actionId,kind,status:"failed",
      sessionId:"sessionId" in message?message.sessionId:undefined,
      error:{code:"action_outcome_unknown",message:"bridge restarted while action outcome was unknown",retryable:true},timestamp:Date.now()});
    this.inFlightActions.add(message.actionId);
    this.saveActionResults();
    let result:ActionResultMessage;
    try {
      if ((message.type === "action.create_session" || message.type === "action.submit_turn")
        && !this.admitNewWork()) {
        throw Object.assign(new Error(this.admissionMessage()), { code: "update_required", retryable: true });
      }
      if(message.type==="action.create_session"){
        const value=await this.adapterForType(message.agentType).createSessionAction(message.actionId,message.projectPath,message.input,message.model,message.attachments);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.submit_turn"){
        const value=await (await this.ensureTurnOwner(message)).submitTurnAction(message.actionId,message.sessionId,message.input,message.delivery,message.expectedTurnId,message.model,message.reasoningEffort,message.attachments);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.interrupt_turn"){
        const value=await this.adapterForSession(message.sessionId).interruptAction(message.sessionId,message.expectedTurnId);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.resolve_approval"){
        await this.adapterForSession(message.sessionId).approve(message.sessionId,message.approvalId,message.choice);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",sessionId:message.sessionId,timestamp:Date.now()};
      }else if(message.type==="action.resolve_user_input"){
        await this.adapterForSession(message.sessionId).respondUserInput(message.sessionId,message.requestId,message.answers);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",sessionId:message.sessionId,timestamp:Date.now()};
      }else{
        const value=await this.adapterForSession(message.sessionId).deleteSessionAction(message.sessionId);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }
    }catch(error){const value=error as Error&{code?:string;retryable?:boolean};result={type:"action.result",actionId:message.actionId,
      kind,status:"failed",sessionId:"sessionId" in message?message.sessionId:undefined,
      error:{code:value.code??"app_server_error",message:value.message||String(error),retryable:value.retryable??true},timestamp:Date.now()};}
    this.actionResults.set(message.actionId,result);this.inFlightActions.delete(message.actionId);
    if(this.actionResults.size>2_000)this.actionResults.delete(this.actionResults.keys().next().value!);
    this.saveActionResults();
    this.send(result);queueMicrotask(()=>void this.updater.activityChanged());
  }

  private async sendHeartbeat(): Promise<void> {
    // Liveness must not depend on the (potentially slow) App Server reads used
    // to reconcile active turns.  Send the heartbeat first so Control Plane
    // never mistakes a busy App Server for an offline Bridge.
    this.send({
      type: "heartbeat", machineId: this.options.machineId, timestamp: Date.now(), ...this.aggregateActivity(),
    });
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    try {
      for (const adapter of this.adapters.values()) {
        if (!adapter.isReady()) continue;
        try {
          await adapter.reconcileActivity();
        } catch (error) {
          log.warn({ error }, "Unable to reconcile adapter activity after heartbeat");
        }
      }
    } finally { this.reconcileInFlight = false; }
  }

  private admitNewWork(): boolean {
    return this.updater.admitStart() && !(this.options.drainFile && existsSync(this.options.drainFile));
  }

  private admissionMessage(): string {
    if (this.options.drainFile && existsSync(this.options.drainFile)) return "bridge is draining for a manual deployment";
    return `bridge update admission state is ${this.updater.admissionState()}`;
  }

  private loadActionResults():void {
    try{const rows=JSON.parse(readFileSync(this.options.actionCachePath,"utf8")) as ActionResultMessage[];
      for(const row of rows)if(row?.type==="action.result"&&row.actionId&&row.timestamp>=Date.now()-this.options.actionCacheTtlMs)this.actionResults.set(row.actionId,row);
    }catch{/* first boot or invalid cache: start empty */}
  }

  private saveActionResults():void {
    try{mkdirSync(dirname(this.options.actionCachePath),{recursive:true});const temp=`${this.options.actionCachePath}.tmp`;
      const rows=[...this.actionResults.values()].filter(row=>row.timestamp>=Date.now()-this.options.actionCacheTtlMs).slice(-2000);
      writeFileSync(temp,JSON.stringify(rows),{mode:0o600});renameSync(temp,this.options.actionCachePath);
    }catch(error){log.warn({error},"Unable to persist action result cache");}
  }
}
