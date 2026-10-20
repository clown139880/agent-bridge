import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import { ControlClient } from "../apps/control-plane/src/mcp/bridge-client.js";
import { BridgeOps } from "../apps/control-plane/src/mcp/bridge-ops.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

type Internals = { http: HttpServer; bridges: Map<string, unknown>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void> };

async function fixture() {
  const path = join(tmpdir(), `bridge-mcp-${randomUUID()}.sqlite`), store = new Store(path);
  store.upsertMachine({ id: "dev", name: "Workstation", platform: "linux", hostname: "dev.local", capabilities: ["codex-cli", "codex-app-server"] });
  const sent: ControlToBridgeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); }, close() {} } as unknown as WebSocket;
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0,
    controlApiReadToken: "read", controlApiWriteToken: "write", bridgeToken: "bridge-registration", sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 } });
  const internals = control as unknown as Internals;
  internals.bridges.set("dev", { machineId: "dev", name: "Workstation", capabilities: ["codex-cli", "codex-app-server"],
    features: ["session-actions", "session-events"], bridgeVersion: "0.4.2", socket });
  await control.start();
  const address = internals.http.address(); assert.ok(address && typeof address === "object");
  const session = (sessionId: string, projectPath: string) => ({ sessionId, nativeSessionId: sessionId, agentType: "codex-cli" as const,
    projectPath, projectName: projectPath.split("/").at(-1)!, title: sessionId, activityStatus: "idle" as const,
    lastTurnStatus: "completed", createdAt: 1000, updatedAt: 2000, source: "app-server" as const, historyCompleteness: "full" as const });
  const bridge = (message: BridgeToControlMessage) => internals.handleBridgeMessage("dev", message);
  await bridge({ type: "state.snapshot", generation: "one", complete: true, approvals: [], userInputs: [],
    sessions: [session("thread-1", "/work/repo"), session("thread-2", "/work/other")] });
  await bridge({ type: "session.event", eventId: "old-done", eventType: "turn.completed", sessionId: "thread-1", turnId: "turn-0",
    timestamp: 2000, payload: { status: "completed", summary: "earlier answer" } });
  const base = `http://127.0.0.1:${address.port}`;
  const ops = new BridgeOps(new ControlClient({ url: base, token: "write" }));
  /** Answer the next dispatched action of `type` the way a Bridge would. */
  const ack = async (type: string, result: Record<string, unknown>) => {
    let action: any;
    for (let i = 0; i < 200 && !(action = sent.find((item) => item.type === type && !(item as any).acked)); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(action, `no ${type} dispatched`); action.acked = true;
    await bridge({ type: "action.result", actionId: action.actionId, kind: type.slice(7) as any, status: "succeeded",
      timestamp: Date.now(), ...result } as BridgeToControlMessage);
    return action;
  };
  let id = 0;
  /** One JSON-RPC call to /mcp/bridge; the SDK answers in SSE frames. */
  const mcp = async (token: string, method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/mcp/bridge`, { method: "POST", headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return { status: response.status, body: (text && JSON.parse(data ? data.slice(6) : text)) as any };
  };
  return { ops, mcp, bridge, ack, sent, async close() { await control.stop(); store.db.close(); rmSync(path, { force: true }); } };
}

test("send then wait returns the turn's final message, even when it finished before the wait", async () => {
  const f = await fixture();
  try {
    const sending = f.ops.send("thread-1", "do the thing");
    const action = await f.ack("action.submit_turn", { sessionId: "thread-1", turnId: "turn-1", resolvedAction: "start_turn" });
    assert.equal(action.input, "do the thing");
    const sent = await sending;
    assert.equal(sent.turnId, "turn-1");
    // An unrelated session finishing must not end the wait.
    await f.bridge({ type: "session.event", eventId: "other-done", eventType: "turn.completed", sessionId: "thread-2", turnId: "x",
      timestamp: Date.now(), payload: { status: "completed", summary: "not mine" } });
    await f.bridge({ type: "session.event", eventId: "t1-msg", eventType: "message.completed", sessionId: "thread-1", turnId: "turn-1",
      timestamp: Date.now(), payload: { role: "assistant", text: "working" } });
    const waiting = f.ops.wait("thread-1", { turnId: sent.turnId!, cursor: sent.cursor, timeoutMs: 5_000 });
    await f.bridge({ type: "session.event", eventId: "t1-done", eventType: "turn.completed", sessionId: "thread-1", turnId: "turn-1",
      timestamp: Date.now(), payload: { status: "completed", summary: "all done" } });
    const result = await waiting;
    assert.equal(result.state, "completed"); assert.equal(result.summary, "all done"); assert.equal(result.turnId, "turn-1");
    // Waiting again after the turn ended answers at once from history.
    const again = await f.ops.wait("thread-1", { turnId: "turn-1", timeoutMs: 1_000 });
    assert.equal(again.state, "completed"); assert.equal(again.summary, "all done");
  } finally { await f.close(); }
});

test("wait stops for an approval, and resumes to completion after the decision", async () => {
  const f = await fixture();
  try {
    const sending = f.ops.send("thread-1", "run tests");
    await f.ack("action.submit_turn", { sessionId: "thread-1", turnId: "turn-1", resolvedAction: "start_turn" });
    const sent = await sending;
    const waiting = f.ops.wait("thread-1", { turnId: "turn-1", cursor: sent.cursor, timeoutMs: 5_000 });
    await f.bridge({ type: "approval_request", sessionId: "thread-1", approvalId: "approval-1", turnId: "turn-1", kind: "command",
      summary: "pnpm test", choices: ["allow", "deny"], requestedAt: Date.now() });
    const stopped = await waiting;
    assert.equal(stopped.state, "approval");
    assert.deepEqual(stopped.approvals?.map((item) => [item.id, item.summary]), [["approval-1", "pnpm test"]]);

    const deciding = f.ops.decide("approval-1", "allow");
    const decision = await f.ack("action.resolve_approval", { sessionId: "thread-1" });
    assert.equal(decision.choice, "allow");
    await deciding;
    await f.bridge({ type: "approval_resolved", sessionId: "thread-1", approvalId: "approval-1", choice: "allow", resolvedAt: Date.now() });
    // Resuming from the returned cursor replays the (now resolved) approval without stopping.
    const resumed = f.ops.wait("thread-1", { turnId: "turn-1", cursor: stopped.cursor, timeoutMs: 5_000 });
    await f.bridge({ type: "session.event", eventId: "t1-done", eventType: "turn.completed", sessionId: "thread-1", turnId: "turn-1",
      timestamp: Date.now(), payload: { status: "completed", summary: "tests pass" } });
    assert.deepEqual([(await resumed).state, (await resumed).summary], ["completed", "tests pass"]);
  } finally { await f.close(); }
});

test("wait on an idle session reports the last turn; a running one can time out", async () => {
  const f = await fixture();
  try {
    const idle = await f.ops.wait("thread-1");
    assert.equal(idle.state, "idle"); assert.equal(idle.summary, "earlier answer");
    await f.bridge({ type: "session.event", eventId: "t2-start", eventType: "turn.started", sessionId: "thread-2", turnId: "turn-9",
      timestamp: Date.now(), payload: { status: "in_progress" } });
    const timedOut = await f.ops.wait("thread-2", { turnId: "turn-9", timeoutMs: 200 });
    assert.equal(timedOut.state, "timeout"); assert.match(timedOut.cursor, /^c:\d+:\d+$/);
  } finally { await f.close(); }
});

test("create resolves a recent workspace by name and returns the new session", async () => {
  const f = await fixture();
  try {
    const creating = f.ops.create({ workerId: "codex@dev", workspace: "repo", input: "start" });
    const action = await f.ack("action.create_session", { sessionId: "thread-new", turnId: "turn-new" });
    assert.equal(action.projectPath, "/work/repo");
    assert.deepEqual({ ...await creating, cursor: undefined },
      { sessionId: "thread-new", turnId: "turn-new", workspace: "/work/repo", cursor: undefined });
    await assert.rejects(f.ops.create({ workerId: "codex@dev", workspace: "nope" }), /not a recent workspace/);
  } finally { await f.close(); }
});

test("/mcp/bridge scopes its tools to the caller's Control token and acts as that caller", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.mcp("bridge-registration", "tools/list")).status, 401, "the Bridge registration token is not a driver");
    assert.equal((await f.mcp("nope", "tools/list")).status, 401);
    const names = async (token: string) => (await f.mcp(token, "tools/list")).body.result.tools.map((tool: any) => tool.name).sort();
    assert.deepEqual(await names("read"), ["pending", "session", "sessions", "wait", "workers"]);
    assert.deepEqual(await names("write"), ["answer", "approve", "create", "interrupt", "pending", "session", "sessions", "turn", "wait", "workers"]);

    const listed = await f.mcp("read", "tools/call", { name: "sessions", arguments: { limit: 5 } });
    assert.deepEqual(listed.body.result.structuredContent.sessions.map((s: any) => s.sessionId).sort(), ["thread-1", "thread-2"]);
    const invalid = await f.mcp("read", "tools/call", { name: "session", arguments: {} });
    assert.ok(invalid.body.error || invalid.body.result?.isError, "schema validation rejects a missing session_id");
    const forbidden = await f.mcp("read", "tools/call", { name: "turn", arguments: { session_id: "thread-1", input: "x" } });
    assert.ok(forbidden.body.error || forbidden.body.result?.isError, "a read token cannot call a write tool");
    const unknown = await f.mcp("write", "tools/call", { name: "create", arguments: { worker_id: "codex@dev", workspace: "nope" } });
    assert.equal(unknown.body.result.isError, true);
    assert.match(unknown.body.result.content[0].text, /^workspace_unknown: /);

    const sending = f.mcp("write", "tools/call", { name: "turn", arguments: { session_id: "thread-1", input: "via mcp" } });
    const action = await f.ack("action.submit_turn", { sessionId: "thread-1", turnId: "turn-1", resolvedAction: "start_turn" });
    assert.equal(action.input, "via mcp");
    const sent = (await sending).body.result.structuredContent;
    assert.equal(sent.turnId, "turn-1");
    const waiting = f.mcp("read", "tools/call", { name: "wait", arguments: { session_id: "thread-1", turn_id: "turn-1", cursor: sent.cursor } });
    await f.bridge({ type: "session.event", eventId: "t1-done", eventType: "turn.completed", sessionId: "thread-1", turnId: "turn-1",
      timestamp: Date.now(), payload: { status: "completed", summary: "done via mcp" } });
    const waited = (await waiting).body.result.structuredContent;
    assert.deepEqual([waited.state, waited.summary], ["completed", "done via mcp"]);
  } finally { await f.close(); }
});
