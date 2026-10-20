import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { AcpAdapter } from "../apps/bridge/src/acp/acp-adapter.js";
import { acpProfiles } from "../apps/bridge/src/acp/profiles.js";
import type { BridgeToControlMessage } from "../packages/protocol/src/index.js";

const MOCK_ACP = fileURLToPath(new URL("./fixtures/mock-acp.mjs", import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  delete process.env.MOCK_ACP_NO_MODEL_STATE;
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-adapter-")));
  const emitted: BridgeToControlMessage[] = [];
  const profile = { ...acpProfiles({ GROK_COMMAND: MOCK_ACP })[0]! };
  const adapter = new AcpAdapter({ profile, allowedRoots: [root] }, (message) => emitted.push(message));
  cleanups.push(() => { adapter.stop(); rmSync(root, { recursive: true, force: true }); });
  const events = (type?: string) => emitted.flatMap((m) => m.type === "session.event" && (!type || m.eventType === type) ? [m] : []);
  return { root, adapter, emitted, events };
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("ACP adapter runs a turn: discovery, streamed reply, title, model and effort", async () => {
  const { root, adapter, emitted, events } = setup();
  await adapter.start();
  const { sessionId, turnId } = await adapter.createSessionAction("action-1", root, "hello", "grok-b", "high");
  assert.match(sessionId, /^grok-/);
  assert.ok(turnId);
  await waitFor(() => events("turn.completed").length === 1);

  const discovered = emitted.find((m) => m.type === "session.discovered");
  assert.ok(discovered?.type === "session.discovered");
  assert.equal(discovered.agentType, "grok");
  assert.equal(discovered.nativeSessionId, "native-1");
  const messages = events("message.completed").map((e) => e.payload);
  assert.deepEqual(messages, [{ role: "user", text: "hello" }, { role: "assistant", text: "echo: hello [grok-b/high]" }]);
  assert.equal(events("turn.completed")[0]!.payload.summary, "echo: hello [grok-b/high]");
  assert.deepEqual(events("progress").map((e) => e.payload.phase), ["thinking", "writing"]);
  const [state] = adapter.stateSnapshot().sessions;
  assert.equal(state?.title, "About hello");
  assert.equal(state?.activityStatus, "idle");
  assert.equal(state?.source, "acp");

  const next = await adapter.submitTurnAction("action-2", sessionId, "again", "auto");
  assert.equal(next.resolvedAction, "start_turn");
  await waitFor(() => events("turn.completed").length === 2);
  assert.equal(events("message.completed").at(-1)!.payload.text, "echo: again [grok-b/high]");
});

test("ACP permission requests become approvals and answer with the chosen option", async () => {
  const { root, adapter, emitted, events } = setup();
  const { sessionId } = await adapter.createSessionAction("action-1", root, "approve echo hi");
  await waitFor(() => emitted.some((m) => m.type === "approval_request"));
  const request = emitted.find((m) => m.type === "approval_request");
  assert.ok(request?.type === "approval_request");
  assert.equal(request.kind, "command");
  assert.equal(request.summary, "Execute `echo hi`");
  assert.deepEqual(request.choices, ["allow", "deny", "allow-session"]);
  assert.equal(adapter.stateSnapshot().sessions[0]?.activityStatus, "waiting_for_approval");
  assert.equal(adapter.stateSnapshot().approvals.length, 1);
  assert.deepEqual(adapter.sessionActivity().blockedSessionIds, [sessionId]);

  await adapter.approve(sessionId, request.approvalId, "allow");
  await waitFor(() => events("turn.completed").length === 1);
  assert.ok(emitted.some((m) => m.type === "approval_resolved" && m.approvalId === request.approvalId));
  assert.deepEqual(events("tool.started").map((e) => e.payload.name), ["run_terminal_command"]);
  const [command] = events("command.completed");
  assert.deepEqual(command?.payload, { command: "echo hi", cwd: root, status: "completed", exitCode: 0, output: "hi" });
  assert.equal(events("message.completed").at(-1)!.payload.text, "allow-once");
  assert.equal(adapter.stateSnapshot().approvals.length, 0);

  await adapter.submitTurnAction("action-2", sessionId, "approve rm x", "start_turn");
  await waitFor(() => emitted.filter((m) => m.type === "approval_request").length === 2);
  const second = emitted.filter((m) => m.type === "approval_request").at(-1);
  assert.ok(second?.type === "approval_request");
  await adapter.approve(sessionId, second.approvalId, "deny");
  await waitFor(() => events("turn.completed").length === 2);
  assert.equal(events("command.completed").at(-1)!.payload.status, "failed");
  assert.equal(events("message.completed").at(-1)!.payload.text, "reject-once");
});

test("ACP interrupt cancels the turn and pending approvals; busy turns queue or refuse", async () => {
  const { root, adapter, events } = setup();
  const { sessionId, turnId } = await adapter.createSessionAction("action-1", root, "wait");
  await waitFor(() => events("progress").some((e) => e.payload.phase === "writing"));
  await assert.rejects(adapter.submitTurnAction("a2", sessionId, "x", "steer"), { code: "steer_unsupported" });
  await assert.rejects(adapter.submitTurnAction("a3", sessionId, "x", "start_turn"), { code: "turn_already_active" });
  const queued = await adapter.submitTurnAction("a4", sessionId, "later", "auto");
  assert.equal(queued.turnId, undefined);

  const interrupted = await adapter.interruptAction(sessionId);
  assert.equal(interrupted.turnId, turnId);
  assert.equal(events("turn.interrupted").length, 1);
  assert.equal(events("message.completed").filter((e) => e.payload.role === "assistant").at(-1)!.payload.text, "working");
  // Interrupt drops the queue, so no further turn starts.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(events("turn.started").length, 1);
  assert.equal(adapter.stateSnapshot().sessions[0]?.lastTurnStatus, "interrupted");
});

test("ACP queued prompts run as the next turn", async () => {
  const { root, adapter, events } = setup();
  const { sessionId } = await adapter.createSessionAction("action-1", root, "approve true");
  await waitFor(() => adapter.stateSnapshot().approvals.length === 1);
  await adapter.submitTurnAction("a2", sessionId, "queued", "auto");
  const approval = adapter.stateSnapshot().approvals[0]!;
  await adapter.approve(sessionId, String(approval.approvalId), "allow-session");
  await waitFor(() => events("turn.completed").length === 2);
  assert.equal(events("message.completed").filter((e) => e.payload.role === "assistant")[0]!.payload.text, "always-allow");
  assert.equal(events("message.completed").at(-1)!.payload.text, "echo: queued [grok-a/medium]");
});

test("ACP resume continues the native session, falling back to a new one", async () => {
  const { root, adapter, emitted } = setup();
  await adapter.resumeSession("grok-old", root, "known-7");
  const resumed = emitted.find((m) => m.type === "session.discovered");
  assert.ok(resumed?.type === "session.discovered");
  assert.equal(resumed.sessionId, "grok-old");
  assert.equal(resumed.nativeSessionId, "known-7");
  assert.equal(resumed.model, "grok-b");

  await adapter.resumeSession("grok-lost", root, "gone-1");
  const fresh = emitted.filter((m) => m.type === "session.discovered").at(-1);
  assert.ok(fresh?.type === "session.discovered");
  assert.equal(fresh.sessionId, "grok-lost");
  assert.equal(fresh.nativeSessionId, "native-1");
  assert.match(adapter.logs("grok-lost", 10), /Resume failed/);

  assert.deepEqual(adapter.reapIdleSessions(60_000), []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(adapter.reapIdleSessions(1).sort(), ["grok-lost", "grok-old"]);
});

test("ACP model catalog comes from initialize, else from a probe session", async () => {
  const { adapter } = setup();
  const models = await adapter.models();
  assert.deepEqual(models.map((m) => [m.id, m.displayName, m.isDefault, m.defaultReasoningEffort]), [
    ["grok-a", "Grok A", true, "medium"], ["grok-b", "Grok B", false, undefined],
  ]);
  assert.deepEqual(models[0]!.supportedReasoningEfforts?.map((e) => e.reasoningEffort), ["low", "medium"]);

  process.env.MOCK_ACP_NO_MODEL_STATE = "1";
  const { adapter: other } = setup();
  const probed = await other.models();
  assert.equal(probed.length, 2);
  assert.deepEqual(probed[1]!.supportedReasoningEfforts?.map((e) => e.reasoningEffort), ["low", "medium", "high"]);
});
