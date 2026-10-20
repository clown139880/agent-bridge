import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

type Internals = {
  http: HttpServer;
  bridges: Map<string, {
    machineId: string; name: string; capabilities: string[]; bridgeVersion?: string; socket: WebSocket;
  }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
};

test("an available bridge update is announced on registration and replayed when the bridge goes idle", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-update-admission-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, send(value: string) {
    sent.push(JSON.parse(value) as ControlToBridgeMessage);
  }, close() {} } as unknown as WebSocket;
  store.upsertMachine({ id: "hal", name: "HAL", platform: "linux", hostname: "hal",
    capabilities: ["codex-cli"] });
  const control = new ControlPlane(store, {
    host: "127.0.0.1", port: 0, workerApiEnabled: true, workerApiToken: "secret",
    bridgeUpdate: { latestVersion: "0.5.0", source: "mock://release", publishedAt: 7 },
  });
  const internals = control as unknown as Internals;
  internals.bridges.set("hal", { machineId: "hal", name: "HAL", capabilities: ["codex-cli"],
    bridgeVersion: "0.4.1", socket });
  await control.start();
  const address = internals.http.address();
  assert.ok(address && typeof address === "object");
  let registering: WebSocket | undefined;
  try {
    const announcement = { type: "bridge_update.available", latestVersion: "0.5.0",
      source: "mock://release", publishedAt: 7, epoch: "0.5.0:7" };
    await internals.handleBridgeMessage("hal", { type: "bridge.idle", machineId: "hal", timestamp: 10 });
    assert.deepEqual(sent.at(-1), announcement, "idle must replay the pending update without polling");

    const announced = new Promise<ControlToBridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("registration was not answered with the update")), 500);
      registering = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`);
      registering.on("message", (data) => {
        const message = JSON.parse(data.toString()) as ControlToBridgeMessage;
        if (message.type === "bridge_update.available") { clearTimeout(timer); resolve(message); }
      });
      registering.once("open", () => registering!.send(JSON.stringify({ type: "register", machineId: "hal2",
        name: "HAL2", hostname: "hal2", platform: "linux", capabilities: ["codex-cli"], bridgeVersion: "0.4.1" })));
    });
    assert.deepEqual(await announced, announcement);
  } finally {
    registering?.close();
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
