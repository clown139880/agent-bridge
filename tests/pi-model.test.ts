import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach, afterEach } from "node:test";
import { PiAdapter } from "../apps/bridge/src/pi/pi-adapter.js";
import type { BridgeToControlMessage } from "../packages/protocol/src/index.js";

const MOCK_PI = fileURLToPath(new URL("./fixtures/mock-pi.mjs", import.meta.url));
const MODELS = [
  { provider: "mock", id: "model-a", name: "Model A", reasoning: true },
  { provider: "mock", id: "model-b", name: "Model B", reasoning: false },
];

let logPath: string;
let emitMessages: BridgeToControlMessage[];
const adapters: PiAdapter[] = [];

beforeEach(() => {
  logPath = join(tmpdir(), `mock-pi-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  emitMessages = [];
  process.env.PI_MOCK_LOG = logPath;
  process.env.PI_MOCK_MODELS = JSON.stringify(MODELS);
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  rmSync(logPath, { force: true });
  delete process.env.PI_MOCK_LOG;
  delete process.env.PI_MOCK_MODELS;
  delete process.env.PI_MOCK_ERROR;
});

function makeAdapter(model?: string): PiAdapter {
  const adapter = new PiAdapter(
    { command: MOCK_PI, provider: "mock", model, sessionDir: tmpdir(), allowedRoots: [tmpdir()] },
    (m) => emitMessages.push(m),
  );
  adapters.push(adapter);
  return adapter;
}

function readCommands(): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("models() surfaces the pi available-model catalog from get_available_models", async () => {
  const adapter = makeAdapter();
  const models = await adapter.models();
  assert.equal(models.length, 2);
  assert.deepEqual(models.map((m) => m.id), ["mock/model-a", "mock/model-b"]);
  assert.equal(models[0].displayName, "Model A");
  assert.equal(models[0].defaultReasoningEffort, "medium");
  assert.equal(models[1].supportedReasoningEfforts, undefined);
});

test("submitTurnAction switches model mid-session when a different model is supplied", async () => {
  const adapter = makeAdapter("model-a");
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-2", sessionId, "continue", "start_turn", undefined, "mock/model-b");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.completed"));
  const setModel = readCommands().find((c) => c.type === "set_model");
  assert.ok(setModel, "expected a set_model command");
  assert.equal(setModel.provider, "mock");
  assert.equal(setModel.modelId, "model-b");
});

test("submitTurnAction does not send set_model when the model is unchanged", async () => {
  const adapter = makeAdapter("model-a");
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-2", sessionId, "continue", "start_turn", undefined, "model-a");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.completed"));
  assert.ok(!readCommands().some((c) => c.type === "set_model"));
});

test("startSession with a model launches pi and records the session", async () => {
  const adapter = makeAdapter();
  const sessionId = await adapter.startSession("run-1", tmpdir(), undefined, undefined, "mock/model-b");
  assert.ok(sessionId.startsWith("pi-"));
  assert.equal(emitMessages.filter((m) => m.type === "session.discovered").length, 1);
  assert.equal(adapter.stateSnapshot().sessions.length, 1);
});

test("startSession with a provider-qualified model uses the prefix as the launch provider", async () => {
  const adapter = makeAdapter("model-a");
  await adapter.startSession("run-1", tmpdir(), undefined, undefined, "other/model-x");
  const launch = readCommands().find((c) => c.type === "launch") as Record<string, unknown>;
  assert.ok(launch, "expected a launch record");
  assert.equal(launch.provider, "other");
  assert.equal(launch.model, "model-x");
});

test("startSession with a bare model keeps the adapter-configured provider", async () => {
  const adapter = makeAdapter("model-a");
  const sessionId = await adapter.startSession("run-1", tmpdir(), undefined, undefined, "model-a");
  assert.ok(sessionId.startsWith("pi-"));
  const launch = readCommands().find((c) => c.type === "launch") as Record<string, unknown>;
  assert.equal(launch.provider, "mock");
  assert.equal(launch.model, "model-a");
});

test("a settled turn whose final assistant message errored is reported as failed", async () => {
  process.env.PI_MOCK_ERROR = "503 model_not_found: no channel for modeldeck/qwen3.8-27b";
  const adapter = makeAdapter("model-a");
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-2", sessionId, "continue", "start_turn");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.failed"));
  const failed = emitMessages.find((m) => m.type === "agent.failed") as { summary: string };
  assert.ok(failed, "expected an agent.failed event");
  assert.equal(failed.summary, "503 model_not_found: no channel for modeldeck/qwen3.8-27b");
  assert.ok(!emitMessages.some((m) => m.type === "agent.completed"), "must not report completed on an errored settle");
});

test("a settled turn with a clean assistant stopReason is reported as completed", async () => {
  const adapter = makeAdapter("model-a");
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-2", sessionId, "continue", "start_turn");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.completed"));
  assert.ok(!emitMessages.some((m) => m.type === "agent.failed"));
});
