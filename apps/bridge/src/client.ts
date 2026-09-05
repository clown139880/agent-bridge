import pino from "pino";
import WebSocket from "ws";
import {
  parseMessage,
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
    updatePackageManager: string;
    updateRestartExecutable: string;
    updateRestartArgs: string[];
  }) {
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
      this.send(message);
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
      const registration: RegisterMessage = {
        type: "register",
        machineId: this.options.machineId,
        name: this.options.machineName,
        hostname: this.options.hostname,
        platform: this.options.platform,
        capabilities: ["codex-cli", "codex-app-server", "local-first", "git"],
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
          log.info({ machineId: message.machineId }, "Bridge registered");
          void this.updater.recoverAfterRestart().catch((error) => {
            log.error({ error }, "Unable to recover self-update state");
          });
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
          void this.codex.startSession(message.sessionId, message.projectPath, message.prompt, message.resumeSessionId)
            .catch((error) => this.send({ type: "error", sessionId: message.sessionId, message: error instanceof Error ? error.message : String(error) }));
          break;
        case "agent_input":
          void this.codex.input(message.sessionId, message.text)
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
}
