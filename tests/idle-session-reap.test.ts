import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach, afterEach } from "node:test";
import { PiAdapter } from "../apps/bridge/src/pi/pi-adapter.js";
import { ClaudeCodeAdapter } from "../apps/bridge/src/claude/claude-adapter.js";
import type { BridgeToControlMessage } from "../packages/protocol/src/index.js";

const MOCK_PI = fileURLToPath(new URL("./fixtures/mock-pi.mjs", import.meta.url));

let logPath: string;
let emitMessages: BridgeToControlMessage[];
const adapters: PiAdapter[] = [];

beforeEach(() => {
  logPath = join(tmpdir(), `mock-pi-reap-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  emitMessages = [];
  process.env.PI_MOCK_LOG = logPath;
  process.env.PI_MOCK_MODELS = "[]";
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  rmSync(logPath, { force: true });
  delete process.env.PI_MOCK_LOG;
  delete process.env.PI_MOCK_MODELS;
});

function makePiAdapter(): PiAdapter {
  const adapter = new PiAdapter(
    { command: MOCK_PI, provider: "mock", sessionDir: tmpdir(), allowedRoots: [tmpdir()] },
    (m) => emitMessages.push(m),
  );
  adapters.push(adapter);
  return adapter;
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("pi: a settled session is reaped once its idle grace elapses", async () => {
  const adapter = makePiAdapter();
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-1", sessionId, "hello", "start_turn");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.completed"));

  // Within the grace window the idle session is preserved for quick follow-ups.
  assert.deepEqual(adapter.reapIdleSessions(60_000), []);
  assert.equal(adapter.stateSnapshot().sessions.length, 1);

  // Once the grace elapses the subprocess is closed and the session dropped.
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(adapter.reapIdleSessions(1), [sessionId]);
  assert.equal(adapter.stateSnapshot().sessions.length, 0);
  // Idempotent: a second sweep has nothing left to reap.
  assert.deepEqual(adapter.reapIdleSessions(1), []);
});

test("pi: an active turn is never reaped, even past the grace", async () => {
  const adapter = makePiAdapter();
  const sessionId = await adapter.startSession("run-1", tmpdir());
  // Force an active turn without letting it settle, then age it well past any grace.
  const session = (adapter as unknown as { sessions: Map<string, { activeTurnId?: string; settledAt?: number }> }).sessions.get(sessionId)!;
  session.activeTurnId = "turn-live";
  session.settledAt = 0;
  assert.deepEqual(adapter.reapIdleSessions(1), []);
  assert.equal(adapter.stateSnapshot().sessions.length, 1);
});

test("pi: a non-positive idle timeout disables reaping", async () => {
  const adapter = makePiAdapter();
  const sessionId = await adapter.startSession("run-1", tmpdir());
  await adapter.submitTurnAction("turn-1", sessionId, "hello", "start_turn");
  await waitFor(() => emitMessages.some((m) => m.type === "agent.completed"));
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(adapter.reapIdleSessions(0), []);
  assert.deepEqual(adapter.reapIdleSessions(-1), []);
  assert.equal(adapter.stateSnapshot().sessions.length, 1);
});

test("claude: reap closes idle sessions but spares active / waiting ones", () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({ command: "", claudeHome: tmpdir(), allowedRoots: [tmpdir()], scanExisting: false }, (e) => events.push(e));
  const sessions = (adapter as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;

  const make = (id: string, over: Record<string, unknown>) => {
    let aborted = false;
    let inputEnded = false;
    const session = {
      sessionId: id,
      ended: false,
      settledAt: Date.now() - 10_000,
      pendingApprovals: new Map(),
      abort: { abort: () => { aborted = true; } },
      input: { end: () => { inputEnded = true; } },
      ...over,
    };
    sessions.set(id, session);
    return { get aborted() { return aborted; }, get inputEnded() { return inputEnded; } };
  };

  const idle = make("idle", {});
  make("active", { activeTurnId: "t1" });
  make("waiting-input", { pendingUserInput: { publicId: "p", resolve: () => {} } });
  const pendingApprovals = new Map([["a1", { answered: false, resolve: () => {} }]]);
  make("waiting-approval", { pendingApprovals });
  make("fresh", { settledAt: Date.now() }); // inside the grace window
  make("recent-message", { lastMessageAt: Date.now() }); // settled long ago, but Claude is still streaming

  const reaped = adapter.reapIdleSessions(1_000);

  assert.deepEqual(reaped, ["idle"]);
  assert.ok(idle.aborted, "reaped session must be aborted");
  assert.ok(idle.inputEnded, "reaped session input stream must be ended");
  assert.ok(!sessions.has("idle"));
  assert.ok(sessions.has("active") && sessions.has("waiting-input") && sessions.has("waiting-approval") && sessions.has("fresh") && sessions.has("recent-message"));

  adapter.stop();
});

test("claude: a non-positive idle timeout disables reaping", () => {
  const adapter = new ClaudeCodeAdapter({ command: "", claudeHome: tmpdir(), allowedRoots: [tmpdir()], scanExisting: false }, () => {});
  const sessions = (adapter as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
  sessions.set("idle", { sessionId: "idle", ended: false, settledAt: 0, pendingApprovals: new Map(), abort: { abort: () => {} }, input: { end: () => {} } });
  assert.deepEqual(adapter.reapIdleSessions(0), []);
  assert.ok(sessions.has("idle"));
  adapter.stop();
});

test("claude: a streamed message restarts the idle clock of a settled session", () => {
  const adapter = new ClaudeCodeAdapter({ command: "", claudeHome: tmpdir(), allowedRoots: [tmpdir()], scanExisting: false }, () => {});
  const internals = adapter as unknown as {
    sessions: Map<string, Record<string, unknown>>;
    handleMessage(session: unknown, message: unknown): void;
  };
  const session: Record<string, unknown> = {
    sessionId: "s", ended: false, settledAt: Date.now() - 10_000, pendingApprovals: new Map(),
    toolUses: new Map(), logs: [], abort: { abort: () => {} }, input: { end: () => {} },
  };
  internals.sessions.set("s", session);
  // Tool result arriving after an approval was answered: the process is working.
  internals.handleMessage(session, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
  assert.deepEqual(adapter.reapIdleSessions(1_000), []);
  session.lastMessageAt = Date.now() - 10_000;
  internals.handleMessage(session, { type: "assistant", message: { content: [] } });
  assert.deepEqual(adapter.reapIdleSessions(1_000), []);
  session.lastMessageAt = Date.now() - 10_000;
  assert.deepEqual(adapter.reapIdleSessions(1_000), ["s"]);
  adapter.stop();
});
