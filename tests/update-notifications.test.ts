import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { AgentBridgeMetadata } from "../apps/control-plane/src/matrix.js";

class CapturingGateway {
  notices: Array<{ body: string; metadata?: AgentBridgeMetadata }> = [];
  async start(): Promise<string> { return "!test:example.org"; }
  stop(): void {}
  async sendRoot(): Promise<string> { return ""; }
  async sendThread(): Promise<string> { return ""; }
  async sendReaction(): Promise<string> { return ""; }
  async removeReaction(): Promise<void> {}
  async sendNotice(body: string, metadata?: AgentBridgeMetadata): Promise<string> {
    this.notices.push({ body, metadata });
    return `$notice-${this.notices.length}`;
  }
}

type ControlInternals = {
  bridges: Map<string, { machineId: string; name: string; capabilities: string[]; bridgeVersion?: string; socket: WebSocket }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
  sendUpdateAnnouncement(socket: WebSocket): void;
};

test("control plane only announces registry data and emits discovered/completed Matrix notices", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-update-notice-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const gateway = new CapturingGateway();
  const sent: ControlToBridgeMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); },
    close() {},
  } as unknown as WebSocket;
  const control = new ControlPlane(store, gateway, {
    host: "127.0.0.1", port: 0,
    bridgeUpdate: { latestVersion: "0.4.0", source: "ssh://trusted/repo", publishedAt: 123 },
  });
  const internals = control as unknown as ControlInternals;
  internals.bridges.set("hal", {
    machineId: "hal", name: "HAL", capabilities: ["codex-cli"], bridgeVersion: "0.3.0", socket,
  });
  try {
    internals.sendUpdateAnnouncement(socket);
    assert.deepEqual(sent, [{
      type: "bridge_update.available", latestVersion: "0.4.0", source: "ssh://trusted/repo", publishedAt: 123,
      epoch: "0.4.0:123",
    }]);
    await internals.handleBridgeMessage("hal", {
      type: "bridge_update.status", phase: "discovered", currentVersion: "0.3.0",
      latestVersion: "0.4.0", updatable: true, fetched: false,
    });
    await internals.handleBridgeMessage("hal", {
      type: "bridge_update.status", phase: "completed", currentVersion: "0.4.0",
      latestVersion: "0.4.0", updatable: true, fetched: true,
    });
    assert.deepEqual(gateway.notices.map(({ metadata }) => metadata?.kind), [
      "bridge.update.discovered", "bridge.update.completed",
    ]);
    assert.match(gateway.notices[0]!.body, /0\.3\.0 → 0\.4\.0/);
    assert.match(gateway.notices[1]!.body, /已完成自更新/);
    assert.equal(internals.bridges.get("hal")?.bridgeVersion, "0.4.0");

    await internals.handleBridgeMessage("hal", {
      type: "bridge_update.status", phase: "completed", currentVersion: "0.4.0",
      latestVersion: "0.4.0", updatable: true, fetched: true,
    });
    assert.equal(gateway.notices.length, 2, "reconnect/status retry must not duplicate notifications");
  } finally {
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
