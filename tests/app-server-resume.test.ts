import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";

function rolloutLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

test("a failed initial App Server connection is retried without restarting Bridge", async () => {
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: true,
    reconnectMs: 10,
  }, () => {});
  let attempts = 0;
  const internals = adapter as unknown as {
    startInternal(): Promise<void>;
    readyPromise?: Promise<void>;
  };
  internals.startInternal = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("App Server did not become ready");
  };

  await assert.rejects(adapter.start(), /did not become ready/);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(attempts, 2);
  assert.ok(internals.readyPromise);
  await internals.readyPromise;
  adapter.stop();
});

test("input resumes a persisted thread before starting a turn", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: false,
    reconnectMs: 3_000,
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") {
      return {
        thread: {
          id: "persisted-thread",
          cwd: process.cwd(),
          status: { type: "idle" },
        },
      };
    }
    return {};
  };

  await adapter.input("persisted-thread", "continue");

  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(calls[1]?.params, {
    threadId: "persisted-thread",
    input: [{ type: "text", text: "continue", text_elements: [] }],
  });
});

test("subsequent input does not resume an already subscribed thread again", async () => {
  const methods: string[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: false,
    reconnectMs: 3_000,
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.request = async (method) => {
    methods.push(method);
    if (method === "thread/resume") {
      return { thread: { id: "persisted-thread", cwd: process.cwd(), status: { type: "idle" } } };
    }
    return {};
  };

  await adapter.input("persisted-thread", "first");
  await adapter.input("persisted-thread", "second");

  assert.deepEqual(methods, ["thread/resume", "turn/start", "turn/start"]);
});

test("Matrix input resumes a completed Desktop thread in its mapped project directory", async () => {
  const root = join(tmpdir(), `agent-bridge-resume-${randomUUID()}`);
  const project = join(root, "project");
  const sessions = join(root, ".codex", "sessions");
  const rollout = join(sessions, "rollout-desktop.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout, [
    rolloutLine({ type: "session_meta", payload: { id: "desktop-thread", cwd: project, originator: "Codex Desktop" } }),
    rolloutLine({ type: "event_msg", payload: { type: "task_started", turn_id: "desktop-turn" } }),
    rolloutLine({ type: "event_msg", payload: { type: "task_complete", turn_id: "desktop-turn" } }),
  ].join(""));

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [root],
    manageServer: false,
    reconnectMs: 3_000,
    desktopHome: join(root, ".codex"),
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") {
      return { thread: { id: "desktop-thread", cwd: project, status: { type: "idle" } } };
    }
    return {};
  };

  await adapter.input("desktop-thread", "continue in Matrix");

  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(calls[1]?.params, {
    threadId: "desktop-thread",
    input: [{ type: "text", text: "continue in Matrix", text_elements: [] }],
    cwd: project,
  });
  adapter.stop();
  rmSync(root, { recursive: true, force: true });
});

test("Matrix cannot take over a Desktop thread while its current turn is active", async () => {
  const root = join(tmpdir(), `agent-bridge-active-${randomUUID()}`);
  const project = join(root, "project");
  const sessions = join(root, ".codex", "sessions");
  const rollout = join(sessions, "rollout-desktop.jsonl");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rollout,
    rolloutLine({ type: "session_meta", payload: { id: "desktop-thread", cwd: project, originator: "Codex Desktop" } }),
  );

  const calls: string[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [root],
    manageServer: false,
    reconnectMs: 3_000,
    desktopHome: join(root, ".codex"),
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.request = async (method) => {
    calls.push(method);
    return {};
  };
  appendFileSync(rollout,
    rolloutLine({ type: "event_msg", payload: { type: "task_started", turn_id: "active-turn" } }),
  );

  await assert.rejects(
    adapter.input("desktop-thread", "please continue"),
    /Codex Desktop is still running this session/,
  );
  assert.deepEqual(calls, []);
  adapter.stop();
  rmSync(root, { recursive: true, force: true });
});

test("resuming an already idle thread does not replay its previous completed turn", async () => {
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: false,
    reconnectMs: 3_000,
  }, () => {});
  let syncCount = 0;
  const internals = adapter as unknown as {
    activeThreads: Set<string>;
    handleNotification(method: string, params: Record<string, unknown>): Promise<void>;
    syncLatestCompletedTurn(threadId: string): Promise<void>;
  };
  internals.syncLatestCompletedTurn = async () => { syncCount += 1; };

  await internals.handleNotification("thread/status/changed", {
    threadId: "persisted-thread",
    status: { type: "idle" },
  });
  assert.equal(syncCount, 0);

  internals.activeThreads.add("persisted-thread");
  await internals.handleNotification("thread/status/changed", {
    threadId: "persisted-thread",
    status: { type: "idle" },
  });
  assert.equal(syncCount, 1);
});
