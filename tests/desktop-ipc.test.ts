import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { DesktopIpc, applyDesktopPatches } from "../apps/bridge/src/desktop-ipc.js";
import { CodexDesktop } from "../apps/bridge/src/codex-desktop.js";
import { materializeAttachment } from "../apps/bridge/src/attachments.js";
import { uploadRequest } from "../apps/control-plane/src/api/validation.js";

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
async function fixture(handle: (message: any, socket: Socket) => void) {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\bridge-test-${randomUUID()}` : join(tmpdir(), `ipc-${randomUUID()}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, 4 + size).toString()); buffer = buffer.subarray(4 + size);
        if (request.method === "initialize") {
          const bytes = frame({ type: "response", requestId: request.requestId, resultType: "success", result: { clientId: "bridge" } });
          socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2)));
        } else handle(request, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return { endpoint, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("IPC frames survive fragmentation and unsolicited discovery; mutations never retry after disconnect", async () => {
  let mutations = 0, discovery = false;
  const host = await fixture((request, socket) => {
    if (request.type === "client-discovery-response") { discovery = true; return; }
    if (request.method === "read") {
      socket.write(Buffer.concat([frame({ type: "client-discovery-request", requestId: "discovery" }), frame({ type: "response", requestId: request.requestId, resultType: "success", result: { ok: true } })]));
    } else { mutations++; socket.destroy(); }
  });
  const ipc = new DesktopIpc(host.endpoint);
  try {
    assert.equal((await ipc.request("read", {}, 1)).result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(discovery, true);
    await assert.rejects(ipc.request("write", {}, 1, undefined, true), (e: any) => e.code === "desktop_outcome_unknown" && !e.retryable);
    assert.equal(mutations, 1);
  } finally { ipc.close(); await host.close(); }
});

test("oversized incoming frame rejects pending mutation without replay", async () => {
  const host = await fixture((_, socket) => { const header = Buffer.alloc(4); header.writeUInt32LE(0xffffffff); socket.write(header); });
  const ipc = new DesktopIpc(host.endpoint);
  try { await assert.rejects(ipc.request("write", {}, 1, undefined, true), (e: any) => e.code === "desktop_outcome_unknown"); }
  finally { ipc.close(); await host.close(); }
});

test("patches preserve previous snapshots, support arrays and reject prototype traversal", () => {
  const state = { turns: [{ text: "before" }] };
  const next = applyDesktopPatches(state, [{ op: "replace", path: ["turns", 0, "text"], value: "after" }, { op: "add", path: ["turns", 1], value: {} }]);
  assert.equal(state.turns[0].text, "before"); assert.equal(next.turns[0].text, "after"); assert.equal(next.turns.length, 2);
  assert.throws(() => applyDesktopPatches(state, [{ op: "add", path: ["__proto__", "polluted"], value: true }]));
  assert.throws(() => applyDesktopPatches(state, [{ op: "replace", path: ["missing", "key"], value: true }]));
});

test("Desktop routes native images, steering, interrupt and pending answers to the current owner", async () => {
  const calls: any[] = [], events: any[] = [], requests: any[] = [];
  let socket: Socket, revision = 1;
  const state: any = { cwd: process.cwd(), id: "thread", title: "Test", createdAt: Date.now(), updatedAt: Date.now(), requests: [], turns: [] };
  const snapshot = () => socket.write(frame({ type: "broadcast", sourceClientId: "owner", method: "thread-stream-state-changed", version: 11,
    params: { hostId: "local", conversationId: "thread", change: { type: "snapshot", revision: revision++, conversationState: state } } }));
  const host = await fixture((request, client) => {
    socket = client; calls.push(request);
    if (request.type === "broadcast") { if (request.params.following) snapshot(); return; }
    let result: any = {};
    if (request.method === "thread-follower-start-turn") {
      state.turns = [{ turnId: "turn", status: "inProgress", params: request.params.turnStart.request, items: [] }]; snapshot(); result = { result: { turn: { id: "turn" } } };
    }
    client.write(frame({ type: "response", requestId: request.requestId, resultType: "success", handledByClientId: "owner", result }));
  });
  const desktop = new CodexDesktop({ endpoint: host.endpoint, validatePath: () => true, notify: async (method, params) => { events.push({ method, params }); }, request: r => requests.push(r), onError: error => { throw error; } });
  try {
    await Promise.all([desktop.follow("thread"), desktop.follow("thread")]);
    assert.equal(calls.filter(r => r.method === "thread-owner-discovery").length, 1);
    const image = { type: "image", url: "data:image/png;base64,YWJj" };
    const started = await desktop.submit("thread", [image], "start_turn"); assert.equal(started.turnId, "turn");
    assert.deepEqual(calls.find(r => r.method === "thread-follower-start-turn").params.turnStart.request.input, [image]);
    await assert.rejects(desktop.submit("thread", [image], "start_turn"), (e: any) => e.code === "turn_already_active");
    await assert.rejects(desktop.submit("thread", [image], "steer", "stale"), (e: any) => e.code === "turn_changed");
    assert.equal((await desktop.submit("thread", [image], "steer", "turn")).resolvedAction, "steer");
    await desktop.call("thread", "thread-follower-interrupt-turn", { mode: "user-stop", expectedTurnId: "turn" }, 4);
    assert.equal(calls.at(-1).version, 4);
    assert.equal(calls.at(-1).targetClientId, "owner");
    state.requests = [{ id: 7, method: "item/tool/requestUserInput", params: { questions: [{ id: "q", question: "Choose" }] } }]; snapshot();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests[0].id, "desktop:thread:7");
    await desktop.reply("thread", requests[0].id, { answers: { q: { answers: ["yes"] } } });
    assert.equal(calls.at(-1).method, "thread-follower-submit-user-input"); assert.equal(calls.at(-1).params.requestId, 7);
    state.requests = [{ id: "approve", method: "item/commandExecution/requestApproval", params: {} }]; snapshot();
    await new Promise(resolve => setTimeout(resolve, 30));
    await desktop.reply("thread", "desktop:thread:approve", { decision: "decline" });
    assert.equal(calls.at(-1).method, "thread-follower-command-approval-decision");
    assert.equal(calls.at(-1).params.decision, "decline");
    socket!.write(frame({ type: "broadcast", sourceClientId: "owner", method: "thread-stream-state-changed", version: 11,
      params: { hostId: "local", conversationId: "thread", change: { type: "patches", baseRevision: -10, revision: 99, patches: [] } } }));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(calls.some(r => r.method === "thread-stream-following-changed" && r.params.following === false));
    assert.equal(desktop.sessions.get("thread")?.fresh, true);
    state.requests = []; state.turns[0].status = "completed"; state.turns[0].items = [{ id: "answer", type: "agentMessage", text: "done" }]; snapshot();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.filter(e => e.method === "turn/completed").length, 1);
    assert.ok(events.some(e => e.method === "serverRequest/resolved"));
    snapshot(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.filter(e => e.method === "turn/completed").length, 1);
  } finally { desktop.close(); await host.close(); }
});

test("attachment bytes are preserved and filename cannot escape the cache; PDF upload is accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-attachments-"));
  try {
    const bytes = Buffer.from("test-document\n");
    const ref = { id: "opaque/ref", filename: "../../secret.txt", mimeType: "text/plain", size: bytes.length };
    const file = await materializeAttachment(ref, async () => ({ ref, mediaType: ref.mimeType, base64: bytes.toString("base64") }), directory);
    assert.equal(file.path.startsWith(directory), true); assert.deepEqual(await readFile(file.path), bytes);
    assert.equal(uploadRequest({ filename: "a.pdf", mimeType: "application/pdf", content: bytes.toString("base64") }).mimeType, "application/pdf");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
