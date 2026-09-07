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
}
