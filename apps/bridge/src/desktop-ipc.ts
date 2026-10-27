import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

export type DesktopRecord = Record<string, any>;
export function desktopError(code: string, message: string, retryable = false): Error & { code: string; retryable: boolean } {
  return Object.assign(new Error(message), { code, retryable });
}

/** Windows Desktop's length-prefixed JSON IPC, not the app-server JSON-RPC transport. */
export class DesktopIpc {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private clientId = "initializing-client";
  private pending = new Map<string, { resolve: (v: DesktopRecord) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; mutation: boolean }>();
  constructor(readonly endpoint = "\\\\.\\pipe\\codex-ipc",
    private readonly broadcast: (message: DesktopRecord) => void = () => {},
    private readonly disconnected: () => void = () => {},
    private readonly timeoutMs = 15_000) {}

  async ready(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed && this.clientId !== "initializing-client") return;
    const attempt = this.open(); this.connecting = attempt;
    try { await attempt; } finally { if (this.connecting === attempt) this.connecting = undefined; }
  }
  private async open(): Promise<void> {
    this.buffer = Buffer.alloc(0); this.clientId = "initializing-client";
    const socket = connect(this.endpoint); this.socket = socket;
    socket.on("data", data => {
      if (this.socket !== socket) return;
      try { this.receive(data); } catch { socket.destroy(desktopError("desktop_protocol_error", "Invalid Desktop IPC frame")); }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.clientId = "initializing-client"; this.buffer = Buffer.alloc(0);
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(desktopError(item.mutation ? "desktop_outcome_unknown" : "desktop_disconnected",
          item.mutation ? "Desktop disconnected after dispatch; check the session before retrying" : "Desktop disconnected", !item.mutation));
      }
      this.pending.clear(); this.disconnected();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(desktopError("desktop_unavailable", "Codex Desktop IPC is unavailable", true)); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(desktopError("desktop_unavailable", "Codex Desktop IPC is unavailable", true)); });
    });
    const response = await this.sendRequest("initialize", { clientType: "agent-bridge" }, 0, undefined, false);
    if (typeof response.result?.clientId !== "string") { socket.destroy(); throw desktopError("desktop_protocol_error", "Desktop did not assign an IPC client id"); }
    this.clientId = response.result.clientId;
  }
  async request(method: string, params: DesktopRecord, version: number, target?: string, mutation = false): Promise<DesktopRecord> {
    await this.ready(); return this.sendRequest(method, params, version, target, mutation);
  }
  private sendRequest(method: string, params: DesktopRecord, version: number, targetClientId: string | undefined, mutation: boolean): Promise<DesktopRecord> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(desktopError(mutation ? "desktop_outcome_unknown" : "desktop_timeout",
          mutation ? "Desktop request timed out after dispatch; do not automatically resend" : "Desktop request timed out", !mutation));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try { this.write({ type: "request", requestId, sourceClientId: this.clientId, method, params, version, targetClientId, timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  notify(method: string, params: DesktopRecord, version: number, targets?: string[]): void {
    this.write({ type: "broadcast", sourceClientId: this.clientId, method, params, version, targetClientIds: targets });
  }
  private write(message: DesktopRecord): void {
    if (!this.socket || this.socket.destroyed) throw desktopError("desktop_unavailable", "Desktop is not connected", true);
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > 128 * 1024 * 1024) throw desktopError("desktop_payload_too_large", "Desktop IPC request exceeds 128 MiB");
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
    this.socket.write(Buffer.concat([header, payload]));
  }
  private receive(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > 128 * 1024 * 1024) throw new Error("Invalid frame size");
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === "response") {
        const pending = this.pending.get(message.requestId); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        if (message.resultType === "success") pending.resolve(message);
        else pending.reject(desktopError(message.error === "no-client-found" ? "desktop_no_owner" : "desktop_request_failed", String(message.error)));
      } else if (message.type === "client-discovery-request") {
        this.write({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      } else if (message.type === "broadcast") this.broadcast(message);
    }
  }
  close(): void { this.socket?.destroy(); }
}

/** Immer patches use path arrays. Never allow prototype keys from the wire. */
export function applyDesktopPatches(state: DesktopRecord, patches: DesktopRecord[]): DesktopRecord {
  const copy = structuredClone(state);
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || !patch.path.length || patch.path.some((key: unknown) =>
      (typeof key !== "string" && typeof key !== "number") || ["__proto__", "prototype", "constructor"].includes(String(key)))) throw new Error("Invalid patch path");
    let target: any = copy;
    for (const key of patch.path.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) throw new Error("Missing patch parent");
      target = target[key];
    }
    const key = patch.path.at(-1);
    if (!target || typeof target !== "object") throw new Error("Invalid patch target");
    if (patch.op === "remove") { if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; }
    else if (patch.op === "add" || patch.op === "replace") {
      if (Array.isArray(target) && patch.op === "add") target.splice(Number(key), 0, patch.value);
      else target[key] = patch.value;
    } else throw new Error("Unsupported patch operation");
  }
  return copy;
}
