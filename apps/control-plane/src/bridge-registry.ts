import type { WebSocket } from "ws";
import type { ControlToBridgeMessage } from "@agent-bridge/protocol";

export interface BridgeConnection {
  machineId: string;
  name: string;
  capabilities: string[];
  features?: string[];
  protocolVersion?: number;
  bridgeVersion?: string;
  socket: WebSocket;
}

export class BridgeRegistry {
  private readonly modelRequests = new Map<string, { machineId: string; resolve(value: unknown): void; timer: NodeJS.Timeout }>()
  constructor(readonly connections = new Map<string, BridgeConnection>()) {}

  get(machineId: string): BridgeConnection | undefined { return this.connections.get(machineId); }
  has(machineId: string): boolean { return this.connections.has(machineId); }
  set(connection: BridgeConnection): void { this.connections.set(connection.machineId, connection); }
  remove(machineId: string, socket: WebSocket): boolean {
    if (this.connections.get(machineId)?.socket !== socket) return false;
    return this.connections.delete(machineId);
  }
  send(machineId: string, message: ControlToBridgeMessage): boolean {
    const bridge = this.connections.get(machineId);
    if (!bridge || bridge.socket.readyState !== 1) return false;
    try { bridge.socket.send(JSON.stringify(message)); return true; }
    catch { return false; }
  }
  requestModels(machineId: string, timeoutMs = 10_000): Promise<unknown> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.modelRequests.delete(requestId); reject(new Error('model catalog request timed out')) }, timeoutMs)
      this.modelRequests.set(requestId, { machineId, resolve, timer })
      if (!this.send(machineId, { type: 'model_catalog_request', requestId })) {
        clearTimeout(timer); this.modelRequests.delete(requestId); reject(new Error('worker is offline'))
      }
    })
  }
  resolveModels(machineId: string, requestId: string, value: unknown): boolean {
    const pending = this.modelRequests.get(requestId)
    if (!pending || pending.machineId !== machineId) return false
    clearTimeout(pending.timer); this.modelRequests.delete(requestId); pending.resolve(value); return true
  }
}
