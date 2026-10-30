import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { AgentMemory, roomRef } from "../packages/agent-memory/src/index.js";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

type Internals = { http: HttpServer; bridges: Map<string, unknown>; handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void> };

function vault(): string {
  const dir = mkdtempSync(join(tmpdir(), "conversations-")), root = join(dir, "agent-memory", "scopes");
  const scope = (id: string, bindings: string) => {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "scope.md"), `---\ntype: scope\nid: ${id}\ntitle: ${id}\nstatus: active\ndiscoverable: true\nbindings:\n${bindings}\nbootstrap_budget: 1500\n---\n`);
    writeFileSync(join(root, id, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  };
  scope("_global", "  matrix_rooms: []\n  repositories: []\n  locations: []");
  scope("repo-app", "  matrix_rooms: [\"!app:example.org\"]\n  repositories: [\"github.com/example/repo\"]\n  locations: []");
  scope("travel", "  rooms: []\n  repositories: []\n  locations: []");
  writeFileSync(join(dir, "agent-memory", "predicates.yaml"), "predicates:\n  - id: fact\n");
  return dir;
}

async function fixture() {
  const path = join(tmpdir(), `conversations-${randomUUID()}.sqlite`), store = new Store(path), memory = vault();
  store.upsertMachine({ id: "hal", name: "HAL", platform: "linux", hostname: "hal", capabilities: ["pi", "codex-cli"] });
  const sent: ControlToBridgeMessage[] = [];
  const socket = { readyState: WebSocket.OPEN, OPEN: WebSocket.OPEN, send(value: string) { sent.push(JSON.parse(value)); }, close() {} } as unknown as WebSocket;
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, version: "9.9.9", controlApiWriteToken: "write",
    agentMemory: { vault: memory }, sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 } });
  const internals = control as unknown as Internals;
  internals.bridges.set("hal", { machineId: "hal", name: "HAL", capabilities: ["pi", "codex-cli"], features: ["session-actions", "session-events"], bridgeVersion: "9.9.9", socket });
  await control.start();
  const address = internals.http.address(); assert.ok(address && typeof address === "object");
  await internals.handleBridgeMessage("hal", { type: "state.snapshot", generation: "g", complete: true, approvals: [], userInputs: [], sessions: [{
    sessionId: "older", nativeSessionId: "older", agentType: "codex-cli", projectPath: "/root/repo", projectName: "repo",
    projectIdentity: "github.com/example/repo", activityStatus: "idle", createdAt: 1, updatedAt: 2, source: "app-server", historyCompleteness: "full" }] });
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const call = async (method: string, route: string, body?: unknown, key?: string) => {
    const response = await fetch(base + route, { method, headers: { authorization: "Bearer write", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, sent, internals, memory, async close() { await control.stop(); store.db.close(); rmSync(path, { force: true }); rmSync(memory, { recursive: true, force: true }); } };
}

test("room refs: bare Matrix ids, threads and other connectors", () => {
  assert.equal(roomRef("!a:example.org"), "matrix:!a:example.org");
  assert.equal(roomRef("!a:example.org:$thread"), "matrix:!a:example.org");
  assert.equal(roomRef("matrix:!a:example.org"), "matrix:!a:example.org");
  assert.equal(roomRef("wechat:wxid_1"), "wechat:wxid_1");
});

test("a room's scope picks the workspace; the room keeps one session until new, and a session reports to one place", async () => {
  const f = await fixture();
  try {
    const room = `/conversations/matrix/${encodeURIComponent("!app:example.org")}`;
    let conversation = (await f.call("GET", room)).body;
    // Legacy matrix_rooms still bind; no location, so the repository's latest session gives the directory.
    assert.deepEqual(conversation.scope, { id: "repo-app", title: "repo-app" });
    assert.equal(conversation.agent, "pi"); assert.equal(conversation.sessionId, null);
    assert.deepEqual(conversation.target, { workerId: "pi@hal", workspace: "/root/repo" });

    const created = await f.call("POST", "/sessions", { workerId: "pi@hal", workspace: "/root/repo", input: "hi", memoryScope: "repo-app" }, "create-1");
    assert.equal(created.status, 202);
    const dispatched = f.sent.find((message) => message.type === "action.create_session");
    assert.equal(dispatched?.type === "action.create_session" && dispatched.memoryScope, "repo-app");
    assert.equal((await f.call("POST", "/sessions", { workerId: "pi@hal", workspace: "/root/repo", memoryScope: "nope" }, "create-2")).status, 400);

    conversation = (await f.call("PUT", room, { sessionId: "older" })).body;
    assert.equal(conversation.sessionId, "older"); assert.equal(conversation.agent, "codex", "binding a session remembers its agent");
    assert.deepEqual(conversation.target, { workerId: "codex@hal", workspace: "/root/repo" });
    // The same session bound in a thread leaves the main timeline.
    await f.call("PUT", room, { threadId: "$root", sessionId: "older" });
    assert.equal((await f.call("GET", room)).body.sessionId, null);
    assert.deepEqual((await f.call("GET", "/conversations/matrix")).body.data, [{ roomId: "!app:example.org", threadId: "$root", sessionId: "older" }]);

    await f.call("POST", "/sessions/older/turns", { input: "go", delivery: "start_turn" }, "turn-1");
    const turn = f.sent.find((message) => message.type === "action.submit_turn");
    assert.equal(turn?.type === "action.submit_turn" && turn.resume?.memoryScope, "repo-app", "a resumed room session bootstraps from the room's scope");

    conversation = (await f.call("PUT", room, { threadId: "$root", sessionId: null, agent: "claude" })).body;
    assert.equal(conversation.sessionId, null); assert.equal(conversation.agent, "claude");
    assert.equal((await f.call("PUT", room, { agent: "gpt" })).status, 400);
  } finally { await f.close(); }
});

test("bind adds the room and a location to central memory and refuses another scope's room", async () => {
  const f = await fixture();
  try {
    const room = `/conversations/matrix/${encodeURIComponent("!trip:example.org")}`;
    assert.equal((await f.call("GET", room)).body.problem, "room_unbound");
    const bound = (await f.call("POST", `${room}/bind`, { scopeId: "travel", location: "hal:/root/projects/travel" })).body;
    assert.deepEqual(bound.target, { workerId: "pi@hal", workspace: "/root/projects/travel" });
    const scope = readFileSync(join(f.memory, "agent-memory", "scopes", "travel", "scope.md"), "utf8");
    assert.match(scope, /matrix:!trip:example\.org/);
    const conflict = await f.call("POST", `/conversations/matrix/${encodeURIComponent("!app:example.org")}/bind`, { scopeId: "travel" });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, "binding_conflict");
    assert.equal(new AgentMemory({ vault: f.memory }).resolveScope({ roomId: "!trip:example.org:$t" }).scope, "travel", "Hermes' bare room ids still resolve");
    // Binding rewrites legacy matrix_rooms into rooms without losing them.
    await f.call("POST", `/conversations/matrix/${encodeURIComponent("!app:example.org")}/bind`, { scopeId: "repo-app", location: "hal:/root/app" });
    const app = readFileSync(join(f.memory, "agent-memory", "scopes", "repo-app", "scope.md"), "utf8");
    assert.doesNotMatch(app, /matrix_rooms/); assert.match(app, /matrix:!app:example\.org/);
  } finally { await f.close(); }
});
