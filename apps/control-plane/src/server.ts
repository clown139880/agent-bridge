import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { Store, type SessionRecord } from "@agent-bridge/database";
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
} from "@agent-bridge/protocol";
import { MatrixGateway } from "./matrix.js";

const log = pino({ name: "control-plane" });

interface BridgeConnection {
  machineId: string;
  socket: WebSocket;
}

interface PendingMatrixApproval {
  approvalId: string;
  sessionId: string;
  machineId: string;
  threadId: string;
  messageEventId: string;
  reactionEventIds: string[];
  choices: ApprovalChoice[];
}

const APPROVAL_REACTIONS: ReadonlyArray<{ key: string; choice: ApprovalChoice; label: string }> = [
  { key: "✅", choice: "allow", label: "允许一次" },
  { key: "❌", choice: "deny", label: "拒绝" },
  { key: "♾️", choice: "allow-session", label: "本 Session 一直允许" },
];

export class ControlPlane {
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly bridges = new Map<string, BridgeConnection>();
  private readonly approvalsByEvent = new Map<string, PendingMatrixApproval>();
  private readonly approvalsById = new Map<string, PendingMatrixApproval>();
  private readonly resolvedApprovalIds = new Set<string>();
  private readonly progressNotifiedSessions = new Set<string>();
  private roomId = "";

  constructor(
    private readonly store: Store,
    private readonly matrix: MatrixGateway,
    private readonly options: { host: string; port: number; bridgeToken?: string },
  ) {
    this.http = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, bridges: this.bridges.size, roomId: this.roomId }));
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
    log.info({ host: this.options.host, port: this.options.port, roomId: this.roomId }, "Control plane listening");
  }

  async stop(): Promise<void> {
    this.matrix.stop();
    for (const bridge of this.bridges.values()) bridge.socket.close(1001, "server shutdown");
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  async onRoomMessage(body: string): Promise<void> {
    const input = body.trim();
    if (input === "!help" || input === "/help") {
      await this.matrix.sendNotice([
        "Agent Control commands:",
        "!codex <project-path|zoxide-query> [initial prompt] (optional remote start)",
        "!codex@<machine-id> <project-path|zoxide-query> [initial prompt]",
        "Use z:<query> to make fuzzy path lookup explicit, for example: !codex z:agent-bridge Fix tests",
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
    const match = input.match(/^!codex(?:@([^\s]+))?\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (match) {
      await this.createCodexSession(match[1], match[2], match[3]);
      return;
    }
    if (input.startsWith("!")) await this.matrix.sendNotice("Unknown command. Send !help for usage.");
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

  async onReaction(targetEventId: string, key: string): Promise<void> {
    const pending = this.approvalsByEvent.get(targetEventId);
    const action = APPROVAL_REACTIONS.find((candidate) => candidate.key === key);
    if (!pending || !action || !pending.choices.includes(action.choice)) return;
    this.forgetApproval(pending);
    await this.removeApprovalReactions(pending);
    const bridge = this.bridges.get(pending.machineId);
    if (!bridge) {
      await this.matrix.sendThread(pending.threadId, `🔴 Bridge ${pending.machineId} is offline; the approval could not be submitted.`);
      return;
    }
    this.send(bridge.socket, {
      type: "approval_response",
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      choice: action.choice,
    });
    this.store.updateSessionStatus(pending.sessionId, "working");
    await this.matrix.sendThread(pending.threadId, `🔐 已选择：${action.label}。Codex 正在继续。`);
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
        this.bridges.set(registeredId, { machineId: registeredId, socket });
        this.store.upsertMachine({
          id: registeredId, name: message.name || registeredId, platform: message.platform,
          hostname: message.hostname, capabilities: message.capabilities,
        });
        this.send(socket, { type: "registered", machineId: registeredId });
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
      if (machineId && this.bridges.get(machineId)?.socket === socket) this.bridges.delete(machineId);
    });
    socket.on("error", (error) => log.warn({ error, machineId }, "Bridge socket error"));
  }

  private async handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void> {
    if (message.type === "heartbeat") {
      this.store.touchMachine(machineId);
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
      const pending = this.approvalsById.get(message.approvalId);
      if (pending) {
        this.forgetApproval(pending);
        await this.removeApprovalReactions(pending);
      } else {
        this.resolvedApprovalIds.add(message.approvalId);
        setTimeout(() => this.resolvedApprovalIds.delete(message.approvalId), 60_000).unref();
      }
      return;
    }
    if (message.type === "error") {
      if (message.sessionId) {
        const session = this.store.getSession(message.sessionId);
        if (session?.matrixThreadId) await this.matrix.sendThread(session.matrixThreadId, `❌ ${message.message}`);
      } else {
        log.warn({ machineId, message: message.message }, "Bridge error");
      }
      return;
    }
    if (message.type.startsWith("agent.")) await this.handleAgentEvent(message as AgentEvent);
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const session = this.store.getSession(event.sessionId);
    if (!session) return;
    if (!this.store.addEvent(event)) return;
    const status = statusForEvent(event.type);
    if (status) this.store.updateSessionStatus(event.sessionId, status);
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
    if (!session?.matrixThreadId) return;
    this.store.updateSessionStatus(message.sessionId, "blocked");
    const messageEventId = await this.matrix.sendThread(session.matrixThreadId, [
      `🔐 Codex 请求授权 · ${approvalKindLabel(message.kind)}`,
      "",
      message.summary,
      "",
      "点击下面的表情选择操作：",
      ...approvalActions(message).map((action) => `${action.key} ${action.label}`),
    ].join("\n"));
    const pending: PendingMatrixApproval = {
      approvalId: message.approvalId,
      sessionId: message.sessionId,
      machineId,
      threadId: session.matrixThreadId,
      messageEventId,
      reactionEventIds: [],
      choices: message.choices,
    };
    if (this.resolvedApprovalIds.delete(message.approvalId)) return;
    this.approvalsByEvent.set(messageEventId, pending);
    this.approvalsById.set(message.approvalId, pending);
    for (const action of approvalActions(message)) {
      try {
        pending.reactionEventIds.push(await this.matrix.sendReaction(messageEventId, action.key));
      } catch (error) {
        log.warn({ error, approvalId: message.approvalId, reaction: action.key }, "Unable to add approval reaction");
      }
    }
  }

  private forgetApproval(pending: PendingMatrixApproval): void {
    this.approvalsByEvent.delete(pending.messageEventId);
    this.approvalsById.delete(pending.approvalId);
  }

  private async removeApprovalReactions(pending: PendingMatrixApproval): Promise<void> {
    const results = await Promise.allSettled(pending.reactionEventIds.map((eventId) => this.matrix.removeReaction(eventId)));
    if (results.some((result) => result.status === "rejected")) {
      log.warn({ approvalId: pending.approvalId }, "Unable to remove one or more approval reactions");
    }
  }

  private async handleSessionDiscovered(machineId: string, message: SessionDiscoveredMessage): Promise<void> {
    let session = this.store.getSessionByNative(machineId, message.nativeSessionId);
    if (session) {
      this.store.updateSessionStatus(session.id, message.status);
      return;
    }
    const now = Date.now();
    session = {
      id: message.sessionId,
      machineId,
      agentType: message.agentType,
      projectName: message.projectName || basename(message.projectPath.replace(/[\\/]$/, "")) || message.projectPath,
      projectPath: message.projectPath,
      matrixRoomId: this.roomId,
      matrixThreadId: null,
      nativeSessionId: message.nativeSessionId,
      status: message.status,
      createdAt: message.createdAt || now,
      updatedAt: now,
    };
    this.store.createSession(session);
    const agentLabel = message.agentType === "codex-desktop" ? "Codex Desktop" : "Codex CLI";
    const matrixThreadId = await this.matrix.sendRoot([
      `${statusIcon(message.status)} ${session.projectName} · ${agentLabel}`,
      "",
      `Machine: ${machineId}`,
      `Project: ${session.projectPath}`,
      `Codex Thread: ${message.nativeSessionId}`,
      message.title ? `Title: ${message.title}` : undefined,
      message.promptSummary ? `Prompt: ${message.promptSummary}` : undefined,
      `Status: ${message.status.toUpperCase()}`,
    ].filter(Boolean).join("\n"));
    this.store.setThread(session.id, matrixThreadId);
    log.info({ machineId, sessionId: session.id, nativeSessionId: message.nativeSessionId }, "Local Codex thread attached");
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

function statusIcon(status: string): string {
  return ({ starting: "🟢", working: "🔵", waiting: "🟡", blocked: "🔴", completed: "✅", failed: "❌", stopped: "⚫" } as Record<string, string>)[status] ?? "⚪";
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
