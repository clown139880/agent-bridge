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

type ControlInternals = {
  bridges: Map<string, { machineId: string; name: string; capabilities: string[]; bridgeVersion?: string; socket: WebSocket }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
  sendUpdateAnnouncement(socket: WebSocket): void;
};

test("control plane only announces registry data and relays update phases to the webhook", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-update-notice-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); },
    close() {},
  } as unknown as WebSocket;
  const control = new ControlPlane(store, {
    host: "127.0.0.1", port: 0,
    bridgeUpdate: { latestVersion: "0.4.0", source: "ssh://trusted/repo", publishedAt: 123 },
  });
  const internals = control as unknown as ControlInternals;
  const webhooks: Array<Record<string, unknown>> = [];
  (control as unknown as { webhook: { notify(event: Record<string, unknown>): void } }).webhook = { notify: (event) => webhooks.push(event) };
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
    assert.deepEqual(webhooks.map((event) => [event.type, event.phase, event.current_version]), [
      ["bridge_update.status", "discovered", "0.3.0"], ["bridge_update.status", "completed", "0.4.0"],
    ]);
    assert.equal(internals.bridges.get("hal")?.bridgeVersion, "0.4.0");
  } finally {
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
