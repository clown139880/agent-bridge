import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { afterEach } from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import type { ControlToBridgeMessage } from "../packages/protocol/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import { PostDeployResumer, type PostDeployIntent } from "../apps/control-plane/src/post-deploy.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function intentsDir(intents: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "post-deploy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, intent] of Object.entries(intents)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(intent));
  return dir;
}

const intent = (overrides: Record<string, unknown> = {}) => ({ machineId: "hal", version: "0.6.82", commit: "2d826d322447",
  previousCommit: "ac393b1aaaaa", nativeSessionId: "38a014a3-0c4d-47c7-83de-a3c47b2bd743", note: "verify pi revive", createdAt: Date.now(), ...overrides });

test("a deploying session is continued once, and only after its Bridge runs the deployed version", () => {
  const dir = intentsDir({ deploy: intent() });
  const submitted: Array<{ sessionId: string; key: string; input: string }> = [];
  const resolved: PostDeployIntent[] = [];
  const resumer = new PostDeployResumer(dir, {
    resolveSession: (found) => { resolved.push(found); return { id: "claude-public", machineId: "hal" }; },
    submitTurn: (sessionId, _machine, key, input) => { submitted.push({ sessionId, key, input }); },
  });
  resumer.bridgeRegistered("dev-windows", "0.6.82");
  resumer.bridgeRegistered("hal", "0.6.81");
  assert.equal(submitted.length, 0, "another machine or an older build continues nothing");
  resumer.bridgeRegistered("hal", "0.6.82");
  resumer.bridgeRegistered("hal", "0.6.82");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.sessionId, "claude-public");
  assert.equal(resolved[0]!.nativeSessionId, "38a014a3-0c4d-47c7-83de-a3c47b2bd743");
  assert.match(submitted[0]!.input, /^\[post-deploy\]/);
  assert.match(submitted[0]!.input, /版本 0\.6\.82（commit 2d826d3，部署前 ac393b1）/);
  assert.match(submitted[0]!.input, /你部署前留下的备注：verify pi revive/);
  assert.deepEqual(readdirSync(dir), []);
});

test("a turn the Bridge refuses keeps the intent for the next registration", () => {
  const dir = intentsDir({ deploy: intent() });
  let refuse = true;
  const submitted: string[] = [];
  const resumer = new PostDeployResumer(dir, {
    resolveSession: () => ({ id: "s", machineId: "hal" }),
    submitTurn: (_s, _m, key) => { if (refuse) throw new Error("worker is offline"); submitted.push(key); },
  });
  resumer.bridgeRegistered("hal", "0.6.82");
  assert.deepEqual(readdirSync(dir), ["deploy.json"]);
  refuse = false;
  resumer.bridgeRegistered("hal", "0.6.82");
  assert.equal(submitted.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test("expired, unreadable and unknown-session intents are dropped, never retried forever", () => {
  const dir = intentsDir({
    old: intent({ createdAt: Date.now() - 31 * 60_000 }),
    broken: { machineId: "hal" },
    stranger: intent({ nativeSessionId: "unknown" }),
  });
  writeFileSync(join(dir, "garbage.json"), "{not json");
  const submitted: string[] = [];
  const resumer = new PostDeployResumer(dir, {
    resolveSession: () => undefined,
    submitTurn: (sessionId) => { submitted.push(sessionId); },
  });
  resumer.bridgeRegistered("hal", "0.6.82");
  assert.deepEqual(submitted, []);
  assert.deepEqual(readdirSync(dir), []);
});

test("the Control Plane continues the deploying session and announces the in-place Bridge update", async () => {
  const databasePath = join(tmpdir(), `agent-bridge-post-deploy-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  cleanups.push(() => { store.db.close(); rmSync(databasePath, { force: true }); });
  store.upsertMachine({ id: "hal", name: "hal", platform: "linux", hostname: "hal", capabilities: ["claude-code"] });
  store.db.prepare("UPDATE machines SET bridge_version='0.6.81' WHERE id='hal'").run();
  store.createSession({ id: "claude-public", machineId: "hal", agentType: "claude-code", projectName: "agent-bridge",
    projectPath: "/root/agent-bridge", matrixRoomId: "", matrixThreadId: null, nativeSessionId: "38a014a3-0c4d-47c7-83de-a3c47b2bd743",
    status: "completed", createdAt: 1, updatedAt: 1 });
  const dir = intentsDir({ deploy: intent() });
  const gateway = { start: async () => "!room", stop() {}, sendRoot: async () => "", sendThread: async () => "",
    sendReaction: async () => "", removeReaction: async () => {}, sendNotice: async () => "" };
  const control = new ControlPlane(store, gateway as never, { host: "127.0.0.1", port: 0, postDeployDir: dir });
  const webhooks: Array<Record<string, unknown>> = [];
  (control as unknown as { webhook: { notify(event: Record<string, unknown>): void } }).webhook = { notify: (event) => webhooks.push(event) };
  await control.start();
  cleanups.push(() => control.stop());
  const port = ((control as unknown as { http: { address(): AddressInfo } }).http.address()).port;

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  cleanups.push(() => socket.close());
  const received: ControlToBridgeMessage[] = [];
  socket.on("message", (data) => received.push(JSON.parse(data.toString()) as ControlToBridgeMessage));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "register", machineId: "hal", name: "hal", hostname: "hal", platform: "linux",
    capabilities: ["claude-code"], features: ["session-actions"], protocolVersion: 3, bridgeVersion: "0.6.82" }));
  const deadline = Date.now() + 5_000;
  while (!received.some((message) => message.type === "action.submit_turn") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

  const turn = received.find((message) => message.type === "action.submit_turn");
  assert.ok(turn && turn.type === "action.submit_turn", "the deploying session gets a turn");
  assert.equal(turn.sessionId, "claude-public");
  assert.match(turn.input, /你部署前留下的备注：verify pi revive/);
  assert.deepEqual(turn.resume, { agentType: "claude-code", workspace: "/root/agent-bridge",
    nativeSessionId: "38a014a3-0c4d-47c7-83de-a3c47b2bd743" });
  assert.equal(existsSync(join(dir, "deploy.json")), false);
  assert.deepEqual(webhooks.filter((event) => event.type === "bridge_update.status"), [{ type: "bridge_update.status", machine_id: "hal",
    phase: "completed", current_version: "0.6.81", latest_version: "0.6.82", updatable: true }]);
});
