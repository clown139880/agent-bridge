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

test("Hermes worker API starts and observes a headless Codex run", async () => {
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
  const headers = { authorization: "Bearer test-secret", "content-type": "application/json" };

  try {
    const unauthorized = await fetch(`${base}/workers`);
    assert.equal(unauthorized.status, 401);

    const workers = await fetch(`${base}/workers`, { headers }).then((response) => response.json()) as {
      workers: Array<{ id: string; status: string }>;
    };
    assert.deepEqual(workers.workers.map(({ id, status }) => ({ id, status })), [
      { id: "codex@dev", status: "online" },
    ]);

    const startResponse = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({ runId: "run-1", taskId: "task-1", conversationId: "matrix-session-1", workerId: "codex@dev", projectPath: "/work/repo", prompt: "Fix tests" }),
    });
    assert.equal(startResponse.status, 202);
    assert.deepEqual(sent.at(-1), {
      type: "start_agent", sessionId: "run-1", agentType: "codex-cli", projectPath: "/work/repo", prompt: "Fix tests",
    });

    const repeated = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({ runId: "run-1", taskId: "task-1", conversationId: "matrix-session-1", workerId: "codex@dev", projectPath: "/work/repo", prompt: "Fix tests" }),
    });
    assert.equal(repeated.status, 200);
    assert.equal(sent.length, 1, "an idempotent retry must not start a second Codex thread");

    await internals.handleBridgeMessage("dev", {
      type: "session.discovered", requestId: "run-1", sessionId: "thread-1", nativeSessionId: "thread-1",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: Date.now(),
    });

    store.db.prepare("UPDATE sessions SET updated_at=1 WHERE id='thread-1'").run();
    store.db.prepare("UPDATE worker_runs SET updated_at=1 WHERE id='run-1'").run();
    await internals.handleBridgeMessage("dev", {
      type: "heartbeat", machineId: "dev", timestamp: Date.now(),
      activeSessionIds: ["thread-1"], waitingSessionIds: [], blockedSessionIds: [],
    });
    const progressingRun = await fetch(`${base}/runs/run-1`, { headers }).then((response) => response.json()) as {
      status: string; updatedAt: number;
    };
    assert.equal(progressingRun.status, "working");
    assert.ok(progressingRun.updatedAt > 1, "an active long run must advance updatedAt without output events");

    store.db.prepare("UPDATE sessions SET status='blocked', updated_at=1 WHERE id='thread-1'").run();
    store.db.prepare("UPDATE worker_runs SET status='blocked', error=NULL, updated_at=1 WHERE id='run-1'").run();
    await internals.handleBridgeMessage("dev", {
      type: "heartbeat", machineId: "dev", timestamp: Date.now(),
      activeSessionIds: ["thread-1"], waitingSessionIds: [], blockedSessionIds: [],
    });
    const repairedRun = await fetch(`${base}/runs/run-1`, { headers }).then((response) => response.json()) as {
      status: string; error: string | null; approvals: unknown[];
    };
    assert.equal(repairedRun.status, "working", "reasonless blocked state must be repaired from live activity");
    assert.equal(repairedRun.error, null);
    assert.deepEqual(repairedRun.approvals, []);

    store.createWorkerRun({
      id: "orphan-run", taskId: "orphan-task", conversationId: null, machineId: "dev",
      agentType: "codex-cli", projectPath: "/work/repo", sessionId: null,
      status: "starting", error: null, createdAt: 1, updatedAt: 1,
    });
    await internals.handleBridgeMessage("dev", {
      type: "session.discovered", requestId: "orphan-run", sessionId: "orphan-thread", nativeSessionId: "orphan-thread",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: 1,
    });
    store.db.prepare("UPDATE sessions SET status='blocked' WHERE id='orphan-thread'").run();
    store.db.prepare("UPDATE worker_runs SET status='blocked', error=NULL WHERE id='orphan-run'").run();
    const freshReclaim = await fetch(`${base}/runs/orphan-run/reclaim`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(freshReclaim.status, 409, "a newly blocked run must survive the reclaim grace period");
    store.db.prepare("UPDATE sessions SET status='blocked', updated_at=1 WHERE id='orphan-thread'").run();
    store.db.prepare("UPDATE worker_runs SET status='blocked', error=NULL, updated_at=1 WHERE id='orphan-run'").run();
    const reclaimed = await fetch(`${base}/runs/orphan-run/reclaim`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(reclaimed.status, 200);
    assert.equal(store.getWorkerRun("orphan-run")?.status, "failed");
    assert.deepEqual(sent.at(-1), { type: "stop_agent", sessionId: "orphan-thread" });

    const legacyResume = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        runId: "orphan-retry", taskId: "orphan-task", conversationId: "hermes-task:board:orphan-task",
        workerId: "codex@dev", projectPath: "/work/repo", prompt: "Continue the interrupted task",
      }),
    });
    assert.equal(legacyResume.status, 202);
    assert.deepEqual(sent.at(-1), {
      type: "start_agent", sessionId: "orphan-retry", resumeSessionId: "orphan-thread",
      agentType: "codex-cli", projectPath: "/work/repo", prompt: "Continue the interrupted task",
    });
    await internals.handleBridgeMessage("dev", {
      type: "error", sessionId: "orphan-retry", message: "test cleanup",
    });

    await internals.handleBridgeMessage("dev", {
      type: "approval_resolved", sessionId: "thread-1", approvalId: "approval-already-resolved",
    });
    await internals.handleBridgeMessage("dev", {
      type: "approval_request", sessionId: "thread-1", approvalId: "approval-already-resolved",
      kind: "command", summary: "Already approved locally", choices: ["allow", "deny"],
    });
    const racedApprovalRun = await fetch(`${base}/runs/run-1`, { headers }).then((response) => response.json()) as {
      status: string; error: string | null; approvals: unknown[];
    };
    assert.equal(racedApprovalRun.status, "working", "a resolved approval must not leave the run blocked");
    assert.equal(racedApprovalRun.error, null);
    assert.deepEqual(racedApprovalRun.approvals, []);

    await internals.handleBridgeMessage("dev", {
      type: "approval_request", sessionId: "thread-1", approvalId: "approval-1",
      kind: "command", summary: "Run pnpm test", choices: ["allow", "deny"],
    });
    const blockedRun = await fetch(`${base}/runs/run-1`, { headers }).then((response) => response.json()) as {
      status: string; approvals: Array<{ approvalId: string; choices: string[] }>;
    };
    assert.equal(blockedRun.status, "blocked");
    assert.deepEqual(blockedRun.approvals, [{
      approvalId: "approval-1", kind: "command", summary: "Run pnpm test", choices: ["allow", "deny"],
    }]);
    const approvalResponse = await fetch(`${base}/runs/run-1/approvals/approval-1`, {
      method: "POST", headers, body: JSON.stringify({ choice: "allow" }),
    });
    assert.equal(approvalResponse.status, 202);
    assert.deepEqual(sent.at(-1), {
      type: "approval_response", sessionId: "thread-1", approvalId: "approval-1", choice: "allow",
    });

    await internals.handleBridgeMessage("dev", {
      type: "agent.completed", eventId: "event-1", sessionId: "thread-1", timestamp: Date.now(), summary: "Tests fixed",
    });
    await internals.handleBridgeMessage("dev", {
      type: "agent.progress", eventId: "event-1-late", sessionId: "thread-1", timestamp: Date.now(),
      summary: "late file notification",
    });

    const run = await fetch(`${base}/runs/run-1`, { headers }).then((response) => response.json()) as {
      status: string; sessionId: string;
    };
    assert.equal(run.status, "completed");
    assert.equal(run.sessionId, "thread-1");

    const eventPage = await fetch(`${base}/runs/run-1/events?after=0`, { headers }).then((response) => response.json()) as {
      next: number; events: Array<{ sequence: number; event: { type: string; summary?: string } }>;
    };
    assert.equal(eventPage.events.length, 2);
    assert.equal(eventPage.events[0]?.event.type, "agent.completed");
    assert.equal(eventPage.events[0]?.event.summary, "Tests fixed");
    assert.equal(eventPage.events[1]?.event.type, "agent.progress");
    assert.equal(eventPage.next, eventPage.events[1]?.sequence);

    const resumeResponse = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        runId: "run-2", taskId: "task-2", conversationId: "matrix-session-1",
        workerId: "codex@dev", projectPath: "/work/repo", prompt: "What did I ask you to remember?",
      }),
    });
    assert.equal(resumeResponse.status, 202);
    assert.deepEqual(sent.at(-1), {
      type: "start_agent", sessionId: "run-2", resumeSessionId: "thread-1",
      agentType: "codex-cli", projectPath: "/work/repo", prompt: "What did I ask you to remember?",
    });
    const concurrentResume = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        runId: "run-3", taskId: "task-3", conversationId: "matrix-session-1",
        workerId: "codex@dev", projectPath: "/work/repo", prompt: "race",
      }),
    });
    assert.equal(concurrentResume.status, 409, "one Codex thread must not accept concurrent runs");
    await internals.handleBridgeMessage("dev", {
      type: "session.discovered", requestId: "run-2", sessionId: "thread-1", nativeSessionId: "thread-1",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: Date.now(),
    });
    await internals.handleBridgeMessage("dev", {
      type: "agent.completed", eventId: "event-2", sessionId: "thread-1", timestamp: Date.now(),
      summary: "You asked me to remember cobalt-orchid-731.",
    });
    const resumedEvents = await fetch(`${base}/runs/run-2/events?after=0`, { headers })
      .then((response) => response.json()) as {
        events: Array<{ event: { summary?: string } }>;
      };
    assert.deepEqual(resumedEvents.events.map(({ event }) => event.summary), [
      "You asked me to remember cobalt-orchid-731.",
    ]);
    const originalEvents = await fetch(`${base}/runs/run-1/events?after=0`, { headers })
      .then((response) => response.json()) as { events: unknown[] };
    assert.equal(originalEvents.events.length, 2, "resumed run events must not leak into the earlier run");

    const explicitBlockResponse = await fetch(`${base}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        runId: "run-4", taskId: "task-4", workerId: "codex@dev",
        projectPath: "/work/repo", prompt: "Exercise an explicit blocked state",
      }),
    });
    assert.equal(explicitBlockResponse.status, 202);
    await internals.handleBridgeMessage("dev", {
      type: "session.discovered", requestId: "run-4", sessionId: "thread-4", nativeSessionId: "thread-4",
      agentType: "codex-cli", projectPath: "/work/repo", status: "working", createdAt: Date.now(),
    });
    await internals.handleBridgeMessage("dev", {
      type: "agent.blocked", sessionId: "thread-4", timestamp: Date.now(), summary: "Unsupported server request is pending",
    });
    const explicitlyBlockedRun = await fetch(`${base}/runs/run-4`, { headers })
      .then((response) => response.json()) as { status: string; error: string | null; approvals: unknown[] };
    assert.equal(explicitlyBlockedRun.status, "blocked");
    assert.equal(explicitlyBlockedRun.error, "Unsupported server request is pending");
    assert.deepEqual(explicitlyBlockedRun.approvals, []);

    await internals.handleBridgeMessage("dev", {
      type: "agent.output", sessionId: "thread-4", timestamp: Date.now(), text: "Continuing",
    });
    assert.equal(store.getWorkerRun("run-4")?.status, "working");
    assert.equal(store.getWorkerRun("run-4")?.error, null, "progress clears an obsolete blocked reason");
  } finally {
    await control.stop();
    store.db.close();
    rmSync(databasePath, { force: true });
  }
});
