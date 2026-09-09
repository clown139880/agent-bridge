import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BridgeClient } from "../apps/bridge/src/client.js";
import type { ActionResultMessage, CreateSessionActionMessage } from "../packages/protocol/src/index.js";

test("a manual deployment drain rejects new work without touching the App Server", async () => {
  const drainFile = join(tmpdir(), `agent-bridge-drain-${randomUUID()}`);
  const cachePath = `${drainFile}.actions`;
  writeFileSync(drainFile, "");
  const client = new BridgeClient({
    url: "ws://127.0.0.1:1/bridge", machineId: "dev", machineName: "dev", hostname: "dev.local",
    platform: process.platform, command: "codex", appServerUrl: "ws://127.0.0.1:1", manageAppServer: false,
    desktopScanIntervalMs: 3_000, desktopReplayExisting: false, allowedRoots: [tmpdir()], reconnectMs: 1_000,
    version: "0.6.1", updateEnabled: false, updateSourceRef: "main", updateInstallRoot: tmpdir(),
    updateCurrentLink: join(tmpdir(), "unused-current"), updateStatePath: join(tmpdir(), "unused-state"),
    actionCachePath: cachePath, actionCacheTtlMs: 86_400_000, drainFile, updatePackageManager: "pnpm",
    updateRestartExecutable: "true", updateRestartArgs: [],
  });
  const internals = client as unknown as {
    codex: { createSessionAction(): Promise<{ sessionId: string }> };
    updater: { admitStart(): boolean; admissionState(): "ready"; activityChanged(): Promise<void> };
    send(message: ActionResultMessage): void;
    handleAction(message: CreateSessionActionMessage): Promise<void>;
  };
  let calls = 0;
  internals.codex = { createSessionAction: async () => { calls += 1; return { sessionId: "thread" }; } };
  internals.updater = { admitStart: () => true, admissionState: () => "ready", activityChanged: async () => {} };
  const sent: ActionResultMessage[] = [];
  internals.send = (message) => sent.push(message);

  try {
    await internals.handleAction({ type: "action.create_session", actionId: "drained", projectPath: tmpdir() });
    assert.equal(calls, 0);
    assert.equal(sent[0]?.status, "failed");
    assert.equal(sent[0]?.error?.code, "update_required");

    rmSync(drainFile, { force: true });
    await internals.handleAction({ type: "action.create_session", actionId: "admitted", projectPath: tmpdir() });
    assert.equal(calls, 1);
    assert.equal(sent[1]?.status, "succeeded");
  } finally {
    rmSync(drainFile, { force: true });
    rmSync(cachePath, { force: true });
  }
});
