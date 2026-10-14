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
  readonly enabled = false;
  async start(): Promise<string> { return ""; }
  stop(): void {}
  async sendRoot(): Promise<string> { return ""; }
  async sendThread(): Promise<string> { return ""; }
  async sendReaction(): Promise<string> { return ""; }
  async removeReaction(): Promise<void> {}
  async sendNotice(): Promise<string> { return ""; }
}

type ControlInternals = {
  http: HttpServer;
  bridges: Map<string, { machineId: string; name: string; capabilities: string[]; socket: WebSocket }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
};

test("the legacy worker-run routes are gone but the WORKER_API_TOKEN principal still reads the Control API", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-worker-api-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const control = new ControlPlane(store, new HeadlessGateway(), {
    host: "127.0.0.1", port: 0, workerApiEnabled: true, workerApiToken: "test-secret",
  });
  const internals = control as unknown as ControlInternals;
  await control.start();
  const address = internals.http.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const headers = { authorization: "Bearer test-secret", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/workers`)).status, 401);
    assert.equal((await fetch(`${base}/workers`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/runs`, { headers })).status, 200, "the run list stays on the Control API");

    const start = await fetch(`${base}/runs`, { method: "POST", headers,
      body: JSON.stringify({ runId: "run-1", workerId: "codex@dev", projectPath: "/work/repo", prompt: "Fix tests" }) });
    assert.equal(start.status, 404, "POST /runs is no longer a way to start a run");
    assert.equal(store.getWorkerRun("run-1"), undefined);
    for (const [method, path] of [["GET", "/runs/run-1"], ["GET", "/runs/run-1/events"], ["POST", "/runs/run-1/input"],
      ["POST", "/runs/run-1/interrupt"], ["POST", "/runs/run-1/reclaim"], ["POST", "/runs/run-1/approvals/a1"]] as const) {
      const response = await fetch(`${base}${path}`, { method, headers, body: method === "POST" ? "{}" : undefined });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  } finally {
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});

test("a run follows its session through heartbeats, approvals and agent events", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-worker-api-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); },
    close() {},
  } as unknown as WebSocket;
  store.upsertMachine({
    id: "dev", name: "Workstation", platform: "linux", hostname: "dev.local",
    capabilities: ["codex-cli", "codex-app-server"],
  });
  const control = new ControlPlane(store, new HeadlessGateway(), {
    host: "127.0.0.1", port: 0, workerApiEnabled: true, workerApiToken: "test-secret",
  });
  const internals = control as unknown as ControlInternals;
  internals.bridges.set("dev", {
    machineId: "dev", name: "Workstation", capabilities: ["codex-cli", "codex-app-server"], socket,
  });
  await control.start();
  const address = internals.http.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const headers = { authorization: "Bearer test-secret" };
  const listedRun = async (runId: string) => {
    const page = await fetch(`${base}/runs`, { headers }).then((response) => response.json()) as {
      data: Array<{ runId: string; status: string; error: string | null; sessionId: string | null; updatedAt: number }>;
    };
    return page.data.find((run) => run.runId === runId)!;
  };
  const handle = (message: BridgeToControlMessage) => internals.handleBridgeMessage("dev", message);

  try {
    store.createWorkerRun({
      id: "run-1", taskId: "task-1", conversationId: "matrix-session-1", machineId: "dev",
      agentType: "codex-cli", projectPath: "/work/repo", sessionId: null,
      status: "starting", error: null, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await handle({
      type: "session.discovered", requestId: "run-1", sessionId: "thread-1", nativeSessionId: "thread-1",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: Date.now(),
    });
    assert.equal((await listedRun("run-1")).sessionId, "thread-1");

    store.db.prepare("UPDATE sessions SET updated_at=1 WHERE id='thread-1'").run();
    store.db.prepare("UPDATE worker_runs SET updated_at=1 WHERE id='run-1'").run();
    await handle({
      type: "heartbeat", machineId: "dev", timestamp: Date.now(),
      activeSessionIds: ["thread-1"], waitingSessionIds: [], blockedSessionIds: [],
    });
    const progressingRun = await listedRun("run-1");
    assert.equal(progressingRun.status, "working");
    assert.ok(progressingRun.updatedAt > 1, "an active long run must advance updatedAt without output events");

    store.db.prepare("UPDATE sessions SET status='blocked', updated_at=1 WHERE id='thread-1'").run();
    store.db.prepare("UPDATE worker_runs SET status='blocked', error=NULL, updated_at=1 WHERE id='run-1'").run();
    await handle({
      type: "heartbeat", machineId: "dev", timestamp: Date.now(),
      activeSessionIds: ["thread-1"], waitingSessionIds: [], blockedSessionIds: [],
    });
    const repairedRun = await listedRun("run-1");
    assert.equal(repairedRun.status, "working", "reasonless blocked state must be repaired from live activity");
    assert.equal(repairedRun.error, null);

    await handle({ type: "approval_resolved", sessionId: "thread-1", approvalId: "approval-already-resolved" });
    await handle({
      type: "approval_request", sessionId: "thread-1", approvalId: "approval-already-resolved",
      kind: "command", summary: "Already approved locally", choices: ["allow", "deny"],
    });
    const racedApprovalRun = await listedRun("run-1");
    assert.equal(racedApprovalRun.status, "working", "a resolved approval must not leave the run blocked");
    assert.equal(racedApprovalRun.error, null);

    await handle({
      type: "approval_request", sessionId: "thread-1", approvalId: "approval-1",
      kind: "command", summary: "Run pnpm test", choices: ["allow", "deny"],
    });
    assert.equal((await listedRun("run-1")).status, "blocked");
    await handle({ type: "approval_resolved", sessionId: "thread-1", approvalId: "approval-1", choice: "allow" });
    assert.equal((await listedRun("run-1")).status, "working");

    await handle({
      type: "session.event", eventType: "turn.completed", eventId: "turn-1-completed", sessionId: "thread-1", turnId: "turn-1",
      timestamp: Date.now(), payload: { status: "completed", summary: "Tests fixed" },
    });
    await handle({
      type: "agent.completed", eventId: "event-1", sessionId: "thread-1", timestamp: Date.now(), summary: "Tests fixed",
    });
    await handle({
      type: "agent.progress", eventId: "event-1-late", sessionId: "thread-1", timestamp: Date.now(),
      summary: "late file notification",
    });
    const run = await listedRun("run-1");
    assert.equal(run.status, "completed");
    assert.equal(run.sessionId, "thread-1");

    store.createWorkerRun({
      id: "run-4", taskId: null, conversationId: null, machineId: "dev",
      agentType: "codex-cli", projectPath: "/work/repo", sessionId: null,
      status: "starting", error: null, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await handle({
      type: "session.discovered", requestId: "run-4", sessionId: "thread-4", nativeSessionId: "thread-4",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: Date.now(),
    });
    await handle({
      type: "agent.blocked", sessionId: "thread-4", timestamp: Date.now(), summary: "Unsupported server request is pending",
    });
    const explicitlyBlockedRun = await listedRun("run-4");
    assert.equal(explicitlyBlockedRun.status, "blocked");
    assert.equal(explicitlyBlockedRun.error, "Unsupported server request is pending");

    await handle({ type: "agent.output", sessionId: "thread-4", timestamp: Date.now(), text: "Continuing" });
    assert.equal(store.getWorkerRun("run-4")?.status, "working");
    assert.equal(store.getWorkerRun("run-4")?.error, null, "progress clears an obsolete blocked reason");
  } finally {
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
