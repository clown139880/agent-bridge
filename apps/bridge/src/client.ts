import pino from "pino";
import WebSocket from "ws";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BRIDGE_PROTOCOL_VERSION,
  parseMessage,
  type ActionResultMessage,
  type BridgeToControlMessage,
  type ControlToBridgeMessage,
  type RegisterMessage,
} from "@agent-bridge/protocol";
import { CodexAppServerAdapter } from "./app-server.js";
import { BridgeSelfUpdater } from "./self-updater.js";

const log = pino({ name: "bridge-client" });

export class BridgeClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly codex: CodexAppServerAdapter;
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
    command: string;
    appServerUrl: string;
    manageAppServer: boolean;
    desktopHome?: string;
    desktopScanIntervalMs: number;
    desktopReplayExisting: boolean;
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
    updatePackageManager: string;
    updateRestartExecutable: string;
    updateRestartArgs: string[];
  }) {
    this.loadActionResults();
    this.codex = new CodexAppServerAdapter({
      command: options.command,
      url: options.appServerUrl,
      allowedRoots: options.allowedRoots,
      manageServer: options.manageAppServer,
      desktopHome: options.desktopHome,
      desktopScanIntervalMs: options.desktopScanIntervalMs,
      desktopReplayExisting: options.desktopReplayExisting,
      reconnectMs: options.reconnectMs,
    }, (message) => {
      if (["session.discovered", "session.event", "approval_request", "approval_resolved",
        "user_input_request", "user_input_resolved"].includes(message.type)) this.sendDurable(message);
      else this.send(message);
      if (message.type === "agent.completed" || message.type === "agent.failed"
        || message.type === "agent.stopped" || message.type === "approval_resolved") {
        queueMicrotask(() => void this.updater.activityChanged());
      }
    });
    this.updater = new BridgeSelfUpdater({
      enabled: options.updateEnabled,
      currentVersion: options.version,
      source: options.updateSource,
      sourceRef: options.updateSourceRef,
      installRoot: options.updateInstallRoot,
      currentLink: options.updateCurrentLink,
      statePath: options.updateStatePath,
      packageManager: options.updatePackageManager,
      restartExecutable: options.updateRestartExecutable,
      restartArgs: options.updateRestartArgs,
      isBusy: () => !this.codex.isReady() || this.codex.hasActiveSessions(),
      report: (message) => this.send(message),
      reportIdle: () => this.send({ type: "bridge.idle", machineId: this.options.machineId, timestamp: Date.now() }),
    });
  }

  start(): void {
    this.stopped = false;
    void this.codex.start()
      .then(() => this.updater.activityChanged())
      .catch((error) => {
        log.error({ error }, "Unable to initialize Codex App Server adapter");
      });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.codex.stop();
    this.socket?.close(1000, "bridge shutdown");
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
        capabilities: ["codex-cli", "codex-app-server", "local-first", "git"],
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        features: ["session-inventory", "session-events", "session-actions", "turn-steer",
          "turn-interrupt", "approvals", "user-input", "desktop-terminal-history"],
        bridgeVersion: this.options.version,
        token: this.options.token,
      };
      this.send(registration);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        const activity = this.codex.isReady() ? this.codex.sessionActivity() : {};
        this.send({
          type: "heartbeat", machineId: this.options.machineId, timestamp: Date.now(), ...activity,
        });
      }, 15_000);
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
          if (!this.updater.admitStart()) {
            this.send({ type: "error", sessionId: message.sessionId, code: "update_required",
              message: `bridge update admission state is ${this.updater.admissionState()}` });
            break;
          }
          void this.codex.startSession(message.sessionId, message.projectPath, message.prompt, message.resumeSessionId, message.model)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "agent_input":
          void this.codex.input(message.sessionId, message.text, message.model)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "approval_response":
          void this.codex.approve(message.sessionId, message.approvalId, message.choice)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "stop_agent":
          void this.codex.stopSession(message.sessionId)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "log_request":
          this.send({ type: "log_response", sessionId: message.sessionId, text: this.codex.logs(message.sessionId, message.lines) });
          break;
        case "model_catalog_request":
          void this.codex.models().then(models => this.send({ type: "model_catalog_response", requestId: message.requestId, models }))
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
    if(!this.codex.isReady()){setTimeout(()=>this.sendStateSnapshot(),250).unref();return;}
    const snapshot=this.codex.stateSnapshot();
    this.send({type:"state.snapshot",generation:`${Date.now()}`,...snapshot,complete:true} as BridgeToControlMessage);
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
      if(message.type==="action.create_session"){
        const value=await this.codex.createSessionAction(message.actionId,message.projectPath,message.input,message.model);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.submit_turn"){
        const value=await this.codex.submitTurnAction(message.actionId,message.sessionId,message.input,message.delivery,message.expectedTurnId,message.model,message.reasoningEffort);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.interrupt_turn"){
        const value=await this.codex.interruptAction(message.sessionId,message.expectedTurnId);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",...value,timestamp:Date.now()};
      }else if(message.type==="action.resolve_approval"){
        await this.codex.approve(message.sessionId,message.approvalId,message.choice);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",sessionId:message.sessionId,timestamp:Date.now()};
      }else if(message.type==="action.resolve_user_input"){
        await this.codex.respondUserInput(message.sessionId,message.requestId,message.answers);
        result={type:"action.result",actionId:message.actionId,kind,status:"succeeded",sessionId:message.sessionId,timestamp:Date.now()};
      }else{
        const value=await this.codex.deleteSessionAction(message.sessionId);
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
