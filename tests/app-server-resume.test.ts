import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
import type { BridgeToControlMessage } from "../packages/protocol/src/index.js";

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

test("a new run can resume a persisted thread and start its prompt as the next turn", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, (message) => emitted.push(message));
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
      return { thread: { id: "persisted-thread", cwd: process.cwd(), status: { type: "idle" } } };
    }
    return {};
  };

  await adapter.startSession("run-2", process.cwd(), "What did I ask you to remember?", "persisted-thread");

  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(calls[1]?.params, {
    threadId: "persisted-thread",
    input: [{ type: "text", text: "What did I ask you to remember?", text_elements: [] }],
  });
  assert.ok(emitted.some((message) => message.type === "session.discovered"
    && message.requestId === "run-2" && message.sessionId === "persisted-thread"));
});

test("a restored active thread is included in the authoritative heartbeat snapshot", async () => {
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.request = async (method) => method === "thread/resume"
    ? { thread: { id: "active-thread", cwd: process.cwd(), status: { type: "active" } } }
    : {};

  await adapter.input("active-thread", "continue");

  assert.deepEqual(adapter.sessionActivity().activeSessionIds, ["active-thread"]);
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

test("an idle-read race never replays an older completed turn", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: false,
    reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  let resolveRead!: (value: unknown) => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const internals = adapter as unknown as {
    activeThreads: Set<string>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    handleNotification(method: string, params: Record<string, unknown>): Promise<void>;
  };
  internals.request = async () => new Promise((resolve) => {
    resolveRead = resolve;
    markReadStarted();
  });
  internals.activeThreads.add("thread-1");

  const idleNotification = internals.handleNotification("thread/status/changed", {
    threadId: "thread-1",
    status: { type: "idle" },
  });
  await readStarted;
  await internals.handleNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "new-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "new reply" }],
    },
  });
  resolveRead({
    thread: {
      turns: [
        { id: "old-turn", status: "completed", items: [{ type: "agentMessage", text: "old reply" }] },
        { id: "new-turn", status: "completed", items: [{ type: "agentMessage", text: "new reply" }] },
      ],
    },
  });
  await idleNotification;

  const completed = emitted.filter((message) => message.type === "agent.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0] && "summary" in completed[0] ? completed[0].summary : undefined, "new reply");
});

test("a late real-time completion does not duplicate an idle-read completion", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex",
    url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()],
    manageServer: false,
    reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  const turn = {
    id: "turn-1",
    status: "completed" as const,
    items: [{ type: "agentMessage", text: "only once" }],
  };
  const internals = adapter as unknown as {
    activeThreads: Set<string>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    handleNotification(method: string, params: Record<string, unknown>): Promise<void>;
  };
  internals.request = async () => ({ thread: { turns: [turn] } });
  internals.activeThreads.add("thread-1");

  await internals.handleNotification("thread/status/changed", {
    threadId: "thread-1",
    status: { type: "idle" },
  });
  await internals.handleNotification("turn/completed", { threadId: "thread-1", turn });

  const completed = emitted.filter((message) => message.type === "agent.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0] && "eventId" in completed[0] ? completed[0].eventId : undefined,
    "app-server:thread-1:turn-1:terminal");
});
