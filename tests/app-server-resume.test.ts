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

  await adapter.startSession("run-2", process.cwd(), "What did I ask you to remember?", "persisted-thread", "deepseek-chat");

  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(calls[1]?.params, {
    threadId: "persisted-thread",
    input: [{ type: "text", text: "What did I ask you to remember?", text_elements: [] }],
    model: "deepseek-chat",
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

test("history hydration preserves each Codex turn time", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  const internals = adapter as unknown as {
    hydrateThreadHistory(thread: { id: string; cwd: string; createdAt: number; updatedAt: number }): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.request = async () => ({ thread: { turns: [{ id: "old-turn", status: "completed",
    startedAt: 120, completedAt: 150,
    items: [
      { id: "old-prompt", type: "userMessage", content: [{ type: "text", text: "Old question" }] },
      { id: "old-message", type: "agentMessage", text: "Old answer" },
    ] }] } });

  await internals.hydrateThreadHistory({ id: "history-thread", cwd: process.cwd(), createdAt: 100, updatedAt: 200 });

  const history = emitted.filter((message) => message.type === "session.event");
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((message) => message.timestamp), [120_000, 150_000, 150_000]);
});

test("history hydration reuses the live canonical item event ids", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  const internals = adapter as unknown as {
    hydrateThreadHistory(thread: { id: string; cwd: string; createdAt: number; updatedAt: number }): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.request = async () => ({ thread: { turns: [{ id: "turn-1", status: "completed", items: [
    { id: "message-1", type: "agentMessage", text: "answer" },
    { id: "command-1", type: "commandExecution", command: "pwd", status: "completed", exitCode: 0 },
    { id: "files-1", type: "fileChange", changes: [{ path: "a.ts" }] },
  ] }] } });

  await internals.hydrateThreadHistory({ id: "thread-1", cwd: process.cwd(), createdAt: 100, updatedAt: 200 });

  assert.deepEqual(emitted.filter((message) => message.type === "session.event").map((message) => message.eventId), [
    "app-server:thread-1:message-1:message",
    "app-server:thread-1:command-1:command",
    "app-server:thread-1:files-1:file-change",
    "app-server:thread-1:turn-1:terminal:structured",
  ]);
});

test("restoration only hydrates unique threads inside the allowed roots", async () => {
  const root = join(tmpdir(), `agent-bridge-inventory-${randomUUID()}`);
  const allowed = join(root, "allowed");
  const outside = join(root, "outside");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const emitted: BridgeToControlMessage[] = [];
  const reads: string[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [allowed],
    manageServer: false, reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  const internals = adapter as unknown as {
    restoreLoadedThreads(): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.request = async (method, params) => {
    if (method === "thread/list") return { data: [
      { id: "allowed-thread", cwd: allowed, status: { type: "idle" } },
      { id: "allowed-thread", cwd: allowed, status: { type: "idle" } },
      { id: "outside-thread", cwd: outside, status: { type: "idle" } },
    ], nextCursor: null };
    if (method === "thread/loaded/list") return { data: [] };
    if (method === "thread/read") {
      reads.push(String(params.threadId));
      return { thread: { id: params.threadId, status: { type: "idle" }, turns: [] } };
    }
    return {};
  };

  try {
    await internals.restoreLoadedThreads();
    assert.deepEqual(reads, ["allowed-thread", "allowed-thread"]);
    assert.equal(emitted.filter((message) => message.type === "session.discovered").length, 1);
    assert.equal(emitted.some((message) => "sessionId" in message
      && message.sessionId === "outside-thread"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconnect synchronizes active turns after completion notifications were lost", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, () => {});
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    activeTurns: Map<string, string>;
    activeThreads: Set<string>;
    subscribedThreads: Set<string>;
    threadsById: Map<string, { id: string; cwd: string }>;
    restoreLoadedThreads(): Promise<void>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  for (const threadId of ["idle-thread", "changed-thread", "deleted-thread"]) {
    internals.activeTurns.set(threadId, `stale-${threadId}`);
    internals.activeThreads.add(threadId);
    internals.subscribedThreads.add(threadId);
    internals.threadsById.set(threadId, { id: threadId, cwd: process.cwd() });
  }
  internals.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/loaded/list") return { data: [] };
    if (method === "thread/read") {
      if (params.threadId === "idle-thread") {
        return { thread: { id: "idle-thread", cwd: process.cwd(), status: { type: "idle" }, turns: [
          { id: "stale-idle-thread", status: "interrupted" },
        ] } };
      }
      if (params.threadId === "changed-thread") {
        return { thread: { id: "changed-thread", cwd: process.cwd(), status: { type: "active" }, turns: [
          { id: "stale-changed-thread", status: "interrupted" },
          { id: "current-turn", status: "inProgress" },
        ] } };
      }
      throw new Error("thread not found");
    }
    return {};
  };

  await internals.restoreLoadedThreads();

  assert.equal(internals.activeTurns.has("idle-thread"), false);
  assert.equal(internals.activeThreads.has("idle-thread"), false);
  assert.equal(internals.activeTurns.get("changed-thread"), "current-turn");
  assert.equal(internals.activeThreads.has("changed-thread"), true);
  assert.equal(internals.activeTurns.has("deleted-thread"), false);
  assert.equal(internals.activeThreads.has("deleted-thread"), false);
  assert.deepEqual(calls.filter((call) => call.method === "thread/read").map((call) => call.params), [
    { threadId: "idle-thread", includeTurns: true },
    { threadId: "changed-thread", includeTurns: true },
    { threadId: "deleted-thread", includeTurns: true },
  ]);

  await adapter.submitTurnAction("new-turn", "idle-thread", "continue", "auto");
  await adapter.submitTurnAction("steer", "changed-thread", "more", "auto", "current-turn");
  assert.ok(calls.some((call) => call.method === "turn/start" && call.params.threadId === "idle-thread"));
  assert.ok(calls.some((call) => call.method === "turn/steer"
    && call.params.threadId === "changed-thread" && call.params.expectedTurnId === "current-turn"));
});

test("periodic activity reconciliation recovers a lost terminal notification", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({
    command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000,
  }, (message) => emitted.push(message));
  const internals = adapter as unknown as {
    readyPromise: Promise<void>;
    socket: { readyState: number; close(): void };
    activeTurns: Map<string, string>;
    activeThreads: Set<string>;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  internals.readyPromise = Promise.resolve();
  internals.socket = { readyState: 1, close() {} };
  internals.activeTurns.set("thread", "turn");
  internals.activeThreads.add("thread");
  internals.request = async (method) => {
    assert.equal(method, "thread/read");
    return { thread: { id: "thread", cwd: process.cwd(), status: { type: "idle" }, turns: [
      { id: "turn", status: "completed", durationMs: 123, items: [] },
    ] } };
  };

  await adapter.reconcileActivity();

  assert.equal(internals.activeTurns.has("thread"), false);
  assert.equal(internals.activeThreads.has("thread"), false);
  assert.ok(emitted.some((message) => message.type === "agent.completed"));
  assert.ok(emitted.some((message) => message.type === "session.event"
    && message.eventType === "turn.completed"));
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

test("session action serializes steer and enforces expectedTurnId", async () => {
  const calls:Array<{method:string;params:Record<string,unknown>}>=[],emitted:BridgeToControlMessage[]=[];
  const adapter=new CodexAppServerAdapter({command:"codex",url:"ws://127.0.0.1:4500",allowedRoots:[process.cwd()],
    manageServer:false,reconnectMs:3000},message=>emitted.push(message));
  const internals=adapter as unknown as {readyPromise:Promise<void>;socket:{readyState:number;close():void};
    request(method:string,params:Record<string,unknown>):Promise<unknown>;activeTurns:Map<string,string>;
    subscribedThreads:Set<string>;threadsById:Map<string,{id:string;cwd:string}>};
  internals.readyPromise=Promise.resolve();internals.socket={readyState:1,close(){}};
  internals.activeTurns.set("thread","turn-current");internals.subscribedThreads.add("thread");
  internals.threadsById.set("thread",{id:"thread",cwd:process.cwd()});
  internals.request=async(method,params)=>{calls.push({method,params});return {};};
  await assert.rejects(adapter.submitTurnAction("a1","thread","stale","auto","turn-old"),
    (error:any)=>error.code==="turn_changed");
  const result=await adapter.submitTurnAction("a2","thread","continue","auto","turn-current");
  assert.equal(result.resolvedAction,"steer");assert.equal(calls[0]?.method,"turn/steer");
  assert.equal(emitted.some(message=>message.type==="session.event"&&message.eventType==="message.completed"),false);
  await assert.rejects(adapter.submitTurnAction("a3","thread","switch","auto","turn-current","deepseek-chat"),
    (error:any)=>error.code==="model_not_applicable");
});

test("turn events retain the rerouted model through completion", async () => {
  const emitted:BridgeToControlMessage[]=[];
  const adapter=new CodexAppServerAdapter({command:"codex",url:"ws://127.0.0.1:4500",allowedRoots:[process.cwd()],
    manageServer:false,reconnectMs:3000},message=>emitted.push(message));
  const internals=adapter as unknown as {handleNotification(method:string,params:Record<string,unknown>):Promise<void>;
    pendingTurnModels:Map<string,string>};
  internals.pendingTurnModels.set("thread","deepseek-chat");
  await internals.handleNotification("turn/started",{threadId:"thread",turn:{id:"turn-1",status:"inProgress"}});
  await internals.handleNotification("model/rerouted",{threadId:"thread",turnId:"turn-1",fromModel:"deepseek-chat",
    toModel:"deepseek-v3",reason:"fallback"});
  await internals.handleNotification("turn/completed",{threadId:"thread",turn:{id:"turn-1",status:"completed",items:[]}});
  const events=emitted.filter((message):message is Extract<BridgeToControlMessage,{type:"session.event"}>=>message.type==="session.event");
  assert.equal(events.find(event=>event.eventType==="turn.started")?.payload.model,"deepseek-chat");
  assert.deepEqual(events.find(event=>event.eventType==="model.rerouted")?.payload,
    {model:"deepseek-v3",fromModel:"deepseek-chat",toModel:"deepseek-v3",reason:"fallback"});
  assert.equal(events.find(event=>event.eventType==="turn.completed")?.payload.model,"deepseek-v3");
  assert.equal(events.find(event=>event.eventType==="model.rerouted")?.turnId,"turn-1");
});

test("App Server token deltas are not forwarded and turn completion replays user and assistant messages with an explicit turn", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({ command: "codex", url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()], manageServer: false, reconnectMs: 3_000 }, message => emitted.push(message));
  const internals = adapter as unknown as { handleNotification(method: string, params: Record<string, unknown>): Promise<void> };
  await internals.handleNotification("turn/started", { threadId: "thread", turn: { id: "turn-live", status: "inProgress" } });
  await internals.handleNotification("item/agentMessage/delta", {
    threadId: "thread", turnId: "turn-live", itemId: "answer", delta: "Hel",
  });
  await internals.handleNotification("item/reasoning/summaryTextDelta", {
    threadId: "thread", turnId: "turn-live", itemId: "thought", summaryIndex: 0, delta: "Checking",
  });
  await internals.handleNotification("turn/completed", { threadId: "thread", turn: { id: "turn-live", status: "completed",
    items: [
      { id: "question", type: "userMessage", content: [{ type: "text", text: "First prompt" }] },
      { id: "answer", type: "agentMessage", text: "Hello" },
    ] } });
  assert.equal(emitted.some(message => JSON.stringify(message).includes("Checking")), false);
  const messages = emitted.filter((message): message is Extract<BridgeToControlMessage, { type: "session.event" }> =>
    message.type === "session.event" && message.eventType === "message.completed");
  assert.deepEqual(messages.map(message => ({ turnId: message.turnId, role: message.payload.role, text: message.payload.text })), [
    { turnId: "turn-live", role: "user", text: "First prompt" },
    { turnId: "turn-live", role: "assistant", text: "Hello" },
  ]);
});

test("thread updates merge cached metadata and rediscover the session", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({ command: "codex", url: "ws://127.0.0.1:4500",
    allowedRoots: [process.cwd()], manageServer: false, reconnectMs: 3_000 }, (message) => emitted.push(message));
  const internals = adapter as unknown as {
    handleNotification(method: string, params: Record<string, unknown>): Promise<void>;
    threadsById: Map<string, { id: string; cwd: string; name?: string; updatedAt?: number }>;
  };
  internals.threadsById.set("thread-title", { id: "thread-title", cwd: process.cwd(), name: "Old", updatedAt: 1 });

  await internals.handleNotification("thread/updated", {
    thread: { id: "thread-title", name: "Generated title", updatedAt: 2 },
  });

  assert.equal(internals.threadsById.get("thread-title")?.updatedAt, 2);
  assert.ok(emitted.some((message) => message.type === "session.discovered"
    && message.sessionId === "thread-title" && message.title === "Generated title"));
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
