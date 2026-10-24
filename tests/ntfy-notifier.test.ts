import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../packages/database/src/index.js";
import type { BridgeToControlMessage, StructuredSessionEventMessage } from "../packages/protocol/src/index.js";
import { NtfyNotifier } from "../apps/control-plane/src/ntfy.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";

const notification = { kind: "completed" as const, sessionId: "session/中文", title: "修复输入框", machineId: "hal", agent: "codex", summary: "已完成，光标保留在原处。" };

test("ntfy publishes Unicode JSON with server-only credentials and a session link", async t => {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  });
  const notifier = new NtfyNotifier({ url: "https://ntfy.test/", topic: "bridge", token: "test-publisher-token",
    controlCenterUrl: "https://bridge.test/control" });
  notifier.notify(notification);
  await new Promise(setImmediate);
  assert.equal(calls[0].url, "https://ntfy.test/");
  assert.equal(calls[0].headers.get("authorization"), "Bearer test-publisher-token");
  assert.deepEqual(calls[0].body, { topic: "bridge", title: "本轮完成 · 修复输入框", message: "codex · hal\n已完成，光标保留在原处。",
    priority: 3, click: "https://bridge.test/control/sessions/session%2F%E4%B8%AD%E6%96%87" });
  notifier.notify({ ...notification, kind: "input", summary: "下一步怎么做？" });
  assert.equal(calls[1].body.priority, 4);
});

test("ntfy is disabled without configuration and bounds long Unicode notifications", async t => {
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body)); return new Response(null, { status: 200 });
  });
  new NtfyNotifier().notify(notification);
  assert.equal(bodies.length, 0);
  new NtfyNotifier({ url: "https://ntfy.test", topic: "bridge" }).notify({ ...notification, title: "😀".repeat(1000), summary: "😀".repeat(10_000) });
  await new Promise(setImmediate);
  assert.ok(Buffer.byteLength(bodies[0]) < 4096, "long output must fit in a normal ntfy notification");
  assert.ok(!bodies[0].includes("\ufffd"), "truncation must preserve Unicode characters");
  assert.equal(JSON.parse(bodies[0]).click, undefined);
});

test("ntfy failures and timeouts do not reject or block the caller", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network unavailable"); });
  assert.doesNotThrow(() => new NtfyNotifier({ url: "https://ntfy.test", topic: "bridge" }).notify(notification));
  await new Promise(setImmediate);
  let aborted = false;
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }));
  new NtfyNotifier({ url: "https://ntfy.test", topic: "bridge", timeoutMs: 5 }).notify(notification);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(aborted, true);
});

test("Control Plane pushes new results and interactions once across event, snapshot and process replays", async t => {
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body))); return new Response(null, { status: 200 });
  });
  const store = new Store(":memory:");
  t.after(() => store.db.close());
  store.upsertMachine({ id: "hal", name: "hal", hostname: "hal", platform: "linux", capabilities: [] });
  store.createSession({ id: "s", machineId: "hal", agentType: "codex-cli", projectName: "test-project", projectPath: "/work",
    matrixRoomId: "", matrixThreadId: null, nativeSessionId: "native-s", status: "working", createdAt: 1, updatedAt: 1 });
  const makeControl = () => new ControlPlane(store, { host: "127.0.0.1", port: 0, ntfy: { url: "https://ntfy.test", topic: "bridge" } }) as unknown as {
    handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
  };
  const control = makeControl();
  const event = (eventType: StructuredSessionEventMessage["eventType"], payload: Record<string, unknown> = {}): StructuredSessionEventMessage => ({
    type: "session.event", eventId: eventType, sessionId: "s", turnId: "t", eventType, timestamp: Date.now(), payload,
  });
  const completed = event("turn.completed", { summary: "任务已完成" }), failed = event("turn.failed", { error: { message: "任务失败原因" } });
  const approval = { type: "approval_request" as const, approvalId: "a", sessionId: "s", turnId: "t", kind: "command" as const,
    summary: "执行命令需要确认", choices: ["allow" as const, "deny" as const], requestedAt: Date.now() };
  const input = { type: "user_input_request" as const, requestId: "q", sessionId: "s", turnId: "t", requestedAt: Date.now(),
    questions: [{ id: "q1", header: "选择", question: "采用哪个方案？", isOther: true, isSecret: false, options: null }] };
  for (const type of ["turn.started", "message.completed", "tool.completed", "turn.interrupted"] as const) {
    await control.handleBridgeMessage("hal", event(type, { role: "assistant", text: "过程消息" }));
  }
  assert.equal(calls.length, 0, "streaming, tools and intentional stops do not send standalone pushes");
  for (const message of [completed, failed, approval, input]) {
    await control.handleBridgeMessage("hal", message);
    await control.handleBridgeMessage("hal", message);
  }
  assert.deepEqual(calls.map(c => c.title), ["本轮完成 · test-project", "本轮失败 · test-project", "等待审批 · test-project", "等待回答 · test-project"]);
  assert.match(calls[1].message, /任务失败原因/);
  const restarted = makeControl();
  for (const message of [completed, failed, approval, input]) await restarted.handleBridgeMessage("hal", message);
  await restarted.handleBridgeMessage("hal", { type: "state.snapshot", generation: "reconnect", sessions: [], approvals: [approval], userInputs: [input], complete: false });
  assert.equal(calls.length, 4, "persisted events and request ids suppress repeats after a Control Plane restart");
  await restarted.handleBridgeMessage("hal", { type: "state.snapshot", generation: "new-request", sessions: [], approvals: [],
    userInputs: [{ ...input, requestId: "new-q" }], complete: false });
  assert.equal(calls.length, 5, "a previously unseen pending request in a snapshot still notifies");
  await new Promise(setImmediate);
});
