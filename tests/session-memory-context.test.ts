import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { AgentMemory } from "../packages/agent-memory/src/index.js";
import { Store, AgentControlStore } from "../packages/database/src/index.js";
import { SessionMemory } from "../apps/control-plane/src/session-memory.js";
import { MatrixControlApi } from "../apps/control-plane/src/matrix/api.js";
import { AgentControlApi } from "../apps/control-plane/src/api/router.js";
import { BridgeRegistry } from "../apps/control-plane/src/bridge-registry.js";
import { contextualInput } from "../apps/bridge/src/session-context.js";
import type { ControlToBridgeMessage } from "../packages/protocol/src/index.js";

function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "room-memory-context-"));
  const root = join(dir, "agent-memory");
  mkdirSync(join(root, "scopes"), { recursive: true });
  writeFileSync(join(root, "predicates.yaml"), "predicates:\n  - id: rule\n");
  for (const id of ["_global", "room", "workspace"]) {
    const scope = join(root, "scopes", id); mkdirSync(scope);
    writeFileSync(join(scope, "scope.md"), `---\ntype: scope\nid: ${id}\ntitle: ${id}\nstatus: active\ndiscoverable: true\nprefetch: true\nbindings:\n  matrix_rooms: ${id === "room" ? '["!room:test"]' : '[]'}\n  repositories: []\n  locations: []\n---\n${id} memory\n`);
    writeFileSync(join(scope, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  }
  const legacy = new Store(join(dir, "db.sqlite")), control = new AgentControlStore(legacy.db, { actionsMs: 10, attachmentsMs: 1000 });
  const agentMemory = new AgentMemory({ vault: dir }), memory = new SessionMemory(control, agentMemory);
  legacy.upsertMachine({ id: "dev", name: "dev", platform: "linux", hostname: "dev", capabilities: ["codex-cli"] });
  control.upsertSession("dev", { sessionId: "s", nativeSessionId: "native", agentType: "codex-cli", projectPath: "/unrelated/workspace", projectName: "workspace",
    activityStatus: "idle", source: "app-server", historyCompleteness: "full", createdAt: 1, updatedAt: 1 });
  t.after(() => { legacy.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, legacy, control, agentMemory, memory };
}

test("scope persists across store recreation; facts change context digest and are delivered only after acceptance", t => {
  const f = setup(t);
  f.control.bindMemory("s", "room", "!room:test");
  const context = f.memory.prepare({ sessionId: "s", input: "hello" })!;
  assert.match(context.text, /_global memory/); assert.match(context.text, /room memory/);
  assert.doesNotMatch(context.text, /workspace memory/); assert.equal(context.changed, true);
  assert.match(contextualInput("hello", context)!, /project-memory/);
  const action = f.control.createAction({ principal: "control:matrix:user", key: "k", method: "POST", path: "/turns", body: {}, kind: "submit_turn", machineId: "dev", sessionId: "s" }).action;
  f.control.saveActionMemory(action.actionId, context, true);
  assert.equal(f.memory.prepare({ sessionId: "s" })!.changed, true, "preparation is not delivery");
  f.control.completeAction({ type: "action.result", actionId: action.actionId, kind: "submit_turn", status: "succeeded", sessionId: "s", timestamp: Date.now() });
  const restored = new AgentControlStore(f.legacy.db, { actionsMs: 10, attachmentsMs: 1000 });
  const memory = new SessionMemory(restored, f.agentMemory);
  assert.equal(memory.prepare({ sessionId: "s" })!.changed, false);
  assert.equal(contextualInput("hello", memory.prepare({ sessionId: "s" })), "hello");
  const before = readFileSync(join(f.root, "scopes", "room", "scope.md"), "utf8");
  f.agentMemory.write({ name: "test", role: "agent" }, { scope: "room", topic: "project", kind: "rule", value: "always keep project context", pin: true });
  assert.equal(readFileSync(join(f.root, "scopes", "room", "scope.md"), "utf8"), before, "scope metadata did not change");
  const changed = memory.prepare({ sessionId: "s" })!;
  assert.notEqual(changed.revision, context.revision); assert.equal(changed.changed, true);
  assert.match(changed.text, /always keep project context/);
  restored.cleanup(); assert.ok(restored.action(action.actionId), "Matrix receipts survive ordinary action retention");
});

test("strict room validation prevents fallback and different-scope cache use", t => {
  const f = setup(t);
  assert.throws(() => f.memory.prepare({ scopeId: "workspace", roomId: "!room:test" }), /绑定冲突/);
  assert.throws(() => f.memory.prepare({ scopeId: "missing" }));
  f.memory.prepare({ scopeId: "room", roomId: "!room:test" });
  const offline = new SessionMemory(f.control);
  assert.equal(offline.prepare({ scopeId: "room", roomId: "!room:test" })!.scopeId, "room");
  assert.throws(() => offline.prepare({ scopeId: "workspace" }), /缓存均不可用/);
  f.control.bindMemory("s", "room");
  assert.throws(() => f.control.bindMemory("s", "workspace"), /scope_conflict/);
});

test("Matrix and browser continuations share API guards and central scope on resume", async t => {
  const f = setup(t), registry = new BridgeRegistry(), sent: ControlToBridgeMessage[] = [];
  registry.connections.set("dev", { machineId: "dev", name: "dev", capabilities: ["codex-cli"], features: ["session-actions", "session-memory"],
    socket: { readyState: WebSocket.OPEN, send(value: string) { sent.push(JSON.parse(value)); } } as WebSocket });
  const api = new AgentControlApi(f.legacy, f.control, registry, { sessionMemory: f.memory,
    sseKeepaliveMs: 1000, ssePollMs: 1000, sseMaxBackpressure: 3, actionTimeoutMs: 100000 });
  const frontend = new MatrixControlApi(api);
  f.control.bindMemory("s", "room", "!room:test");
  const receipt = await frontend.call("@human:test", "/sessions/s/turns", { input: "continue", delivery: "start_turn" }, "turn1");
  const action = sent.at(-1)!;
  assert.equal(action.type, "action.submit_turn");
  if (action.type !== "action.submit_turn") return;
  assert.equal(action.memoryContext?.scopeId, "room"); assert.equal(action.resume?.workspace, "/unrelated/workspace");
  assert.equal(action.resume?.nativeSessionId, "native");
  assert.equal(f.control.actionMemory(receipt.actionId)?.revision, action.memoryContext?.revision);
  assert.equal((await frontend.call("@human:test", "/sessions/s/turns", { input: "continue", delivery: "start_turn" }, "turn1")).actionId, receipt.actionId);
  assert.equal(sent.length, 1);
  f.control.updateSessionActivity("s", "active", "old-turn");
  await assert.rejects(frontend.call("@human:test", "/sessions/s/turns", { input: "overlap", delivery: "start_turn" }, "turn2"), { code: "turn_already_active" });
  f.control.upsertApproval("dev", { sessionId: "s", approvalId: "a", turnId: "old-turn", kind: "command", summary: "command", choices: ["allow", "deny"] });
  await assert.rejects(frontend.call("@human:test", "/approvals/a/decision", { choice: "allow-always" }, "approve1"), { code: "invalid_choice" });
  const accepted = await frontend.call("@human:test", "/approvals/a/decision", { choice: "allow" }, "approve2");
  await assert.rejects(frontend.call("@second:test", "/approvals/a/decision", { choice: "deny" }, "approve3"), { code: "approval_already_resolved" });
  api.actionsForBridge().complete({ type: "action.result", actionId: receipt.actionId, kind: "submit_turn", status: "succeeded", sessionId: "s", timestamp: Date.now() });
  api.actionsForBridge().complete({ type: "action.result", actionId: accepted.actionId, kind: "resolve_approval", status: "succeeded", sessionId: "s", timestamp: Date.now() });
});
