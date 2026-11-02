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
import { CodexAppServerAdapter } from "../apps/bridge/src/app-server.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

const session = (sessionId: string, updatedAt: number) => ({ sessionId, nativeSessionId: sessionId, agentType: "codex-cli", projectPath: "/work/repo",
  projectName: "repo", title: sessionId, activityStatus: "idle", lastTurnStatus: "completed", createdAt: 1000, updatedAt,
  source: "app-server", historyCompleteness: "full" });

/** Register a Bridge over a real socket, send its inventory and collect the backfills asked for. */
async function reconnect(port: number, machineId: string, sessions: unknown[], features = ["history-backfill"]): Promise<ControlToBridgeMessage[]> {
  const received: ControlToBridgeMessage[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ControlToBridgeMessage;
      received.push(message);
      if (message.type === "registered") socket.send(JSON.stringify({ type: "state.snapshot", generation: "g", complete: true, approvals: [], userInputs: [], sessions }));
    });
    socket.once("open", () => socket.send(JSON.stringify({ type: "register", machineId, name: machineId, hostname: machineId, platform: "linux",
      capabilities: ["codex-cli"], bridgeVersion: "0.7.42", features })));
    socket.once("error", reject);
    setTimeout(resolve, 300);
  });
  socket.close();
  return received.filter((message) => message.type === "history.backfill");
}

test("after a reconnect only the sessions that changed while the Bridge was away get their history, from then on", async () => {
  const path = join(tmpdir(), `history-backfill-${randomUUID()}.sqlite`), store = new Store(path);
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0 });
  await control.start();
  const port = ((control as unknown as { http: HttpServer }).http.address() as { port: number }).port;
  try {
    const now = Date.now(), lastSeen = now - 120_000;
    store.upsertMachine({ id: "hal", name: "hal", platform: "linux", hostname: "hal", capabilities: ["codex-cli"] });
    store.db.prepare("UPDATE machines SET last_seen_at=? WHERE id='hal'").run(lastSeen);
    const asked = await reconnect(port, "hal", [session("quiet", lastSeen - 600_000), session("busy", now - 10_000)]);
    assert.deepEqual(asked.map((item: any) => [item.sessionId, item.since]), [["busy", lastSeen - 30_000]], "one timestamp compared per session; only the changed one is read");

    const fresh = await reconnect(port, "new-box", [session("a", now - 5_000), session("b", now - 9_000)]);
    assert.deepEqual(fresh.map((item: any) => [item.sessionId, item.since]), [["a", 0], ["b", 0]], "a machine never seen gets its recent history once");

    assert.equal((await reconnect(port, "old", [session("x", now)], [])).length, 0, "a Bridge without the feature still hydrates on its own");
  } finally { await control.stop(); store.db.close(); rmSync(path, { force: true }); }
});

test("a Codex backfill resends only the turns after `since`, and startup resends nothing", async () => {
  const emitted: BridgeToControlMessage[] = [];
  const adapter = new CodexAppServerAdapter({ command: "codex", url: "ws://127.0.0.1:4500", allowedRoots: [process.cwd()],
    manageServer: false, reconnectMs: 3_000 }, (message) => emitted.push(message));
  const internals = adapter as unknown as { threadsById: Map<string, unknown>; request(method: string, params: Record<string, unknown>): Promise<unknown> };
  internals.threadsById.set("t", { id: "t", cwd: process.cwd(), createdAt: 100, updatedAt: 400 });
  internals.request = async () => ({ thread: { turns: [
    { id: "before", status: "completed", startedAt: 100, completedAt: 150, items: [{ id: "m1", type: "agentMessage", text: "old" }] },
    { id: "after", status: "completed", startedAt: 250, completedAt: 300, items: [{ id: "m2", type: "agentMessage", text: "new" }] },
  ] } });
  await adapter.backfillHistory("t", 200_000);
  assert.deepEqual(emitted.filter((message) => message.type === "session.event").map((message: any) => message.eventId),
    ["app-server:t:m2:message", "app-server:t:after:terminal:structured"]);
});
