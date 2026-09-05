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

class HeadlessGateway {
  async start(): Promise<string> { return ""; }
  stop(): void {}
  async sendRoot(): Promise<string> { return ""; }
  async sendThread(): Promise<string> { return ""; }
  async sendReaction(): Promise<string> { return ""; }
  async removeReaction(): Promise<void> {}
  async sendNotice(): Promise<string> { return ""; }
}

type Internals = {
  http: HttpServer;
  bridges: Map<string, {
    machineId: string; name: string; capabilities: string[]; bridgeVersion?: string; socket: WebSocket;
  }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
};

test("outdated bridges wait for update events and launch only after target-version registration", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-update-admission-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, send(value: string) {
    sent.push(JSON.parse(value) as ControlToBridgeMessage);
  }, close() {} } as unknown as WebSocket;
  store.upsertMachine({ id: "hal", name: "HAL", platform: "linux", hostname: "hal",
    capabilities: ["codex-cli"] });
  const control = new ControlPlane(store, new HeadlessGateway(), {
    host: "127.0.0.1", port: 0, workerApiEnabled: true, workerApiToken: "secret",
    bridgeUpdate: { latestVersion: "0.5.0", source: "mock://release", publishedAt: 7,
      admissionTimeoutMs: 500 },
  });
  const internals = control as unknown as Internals;
  internals.bridges.set("hal", { machineId: "hal", name: "HAL", capabilities: ["codex-cli"],
    bridgeVersion: "0.4.1", socket });
  await control.start();
  const address = internals.http.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/v1/runs`;
  let upgradedSocket: WebSocket | undefined;
  try {
    const response = await fetch(url, { method: "POST", headers: {
      authorization: "Bearer secret", "content-type": "application/json",
    }, body: JSON.stringify({ runId: "waiting-run", workerId: "codex@hal",
      projectPath: "/work/repo", prompt: "mock task" }) });
    assert.equal(response.status, 202);
    assert.equal(store.getWorkerRun("waiting-run")?.status, "update_waiting");
    assert.equal(sent.some((message) => message.type === "start_agent"), false);
    assert.deepEqual(sent.at(-1), { type: "bridge_update.available", latestVersion: "0.5.0",
      source: "mock://release", publishedAt: 7, epoch: "0.5.0:7" });

    const announcements = sent.length;
    await internals.handleBridgeMessage("hal", { type: "bridge.idle", machineId: "hal", timestamp: 10 });
    assert.equal(sent.length, announcements + 1, "idle must replay the pending update without polling");

    await internals.handleBridgeMessage("hal", { type: "bridge_update.status", phase: "failed",
      currentVersion: "0.4.1", latestVersion: "0.5.0", updatable: true, fetched: false,
      reason: "mock validation failure" });
    assert.equal(store.getWorkerRun("waiting-run")?.status, "update_failed");

    upgradedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`);
    const startAfterRegistration = new Promise<ControlToBridgeMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("target-version registration did not release run")), 500);
      upgradedSocket!.on("message", (data) => {
        const message = JSON.parse(data.toString()) as ControlToBridgeMessage;
        if (message.type === "start_agent") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    await new Promise<void>((resolve) => upgradedSocket!.once("open", resolve));
    upgradedSocket.send(JSON.stringify({ type: "register", machineId: "hal", name: "HAL",
      hostname: "hal", platform: "linux", capabilities: ["codex-cli"], bridgeVersion: "0.5.0" }));
    const releasedStart = await startAfterRegistration;
    assert.equal(store.getWorkerRun("waiting-run")?.status, "starting");
    assert.deepEqual(releasedStart, { type: "start_agent", sessionId: "waiting-run",
      agentType: "codex-cli", projectPath: "/work/repo", prompt: "mock task" });
  } finally {
    upgradedSocket?.close();
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});

test("update admission timeout is retryable and never starts a stale bridge", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-update-timeout-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, send(value: string) {
    sent.push(JSON.parse(value) as ControlToBridgeMessage);
  }, close() {} } as unknown as WebSocket;
  store.upsertMachine({ id: "hal", name: "HAL", platform: "linux", hostname: "hal",
    capabilities: ["codex-cli"] });
  const control = new ControlPlane(store, new HeadlessGateway(), {
    host: "127.0.0.1", port: 0, workerApiEnabled: true, workerApiToken: "secret",
    bridgeUpdate: { latestVersion: "0.5.0", source: "mock://release", admissionTimeoutMs: 20 },
  });
  const internals = control as unknown as Internals;
  internals.bridges.set("hal", { machineId: "hal", name: "HAL", capabilities: ["codex-cli"],
    bridgeVersion: "0.4.1", socket });
  await control.start();
  const address = internals.http.address();
  assert.ok(address && typeof address === "object");
  try {
    await fetch(`http://127.0.0.1:${address.port}/api/v1/runs`, { method: "POST", headers: {
      authorization: "Bearer secret", "content-type": "application/json",
    }, body: JSON.stringify({ runId: "timeout-run", workerId: "codex@hal",
      projectPath: "/work/repo", prompt: "mock task" }) });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(store.getWorkerRun("timeout-run")?.status, "update_required");
    assert.equal(sent.some((message) => message.type === "start_agent"), false);
  } finally {
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
