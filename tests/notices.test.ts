import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import { formatOperatorEvent, OperatorNotices, parseNoticeTarget } from "../apps/control-plane/src/notices.js";

type Internals = { http: HttpServer; controlStore: AgentControlStore };

async function fixture() {
  const path = join(tmpdir(), `notices-${randomUUID()}.sqlite`), store = new Store(path);
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, version: "9.9.9", controlApiWriteToken: "write",
    noticeTarget: { connector: "matrix", roomId: "!ops:example.org", threadId: "" }, sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 } });
  const internals = control as unknown as Internals;
  await control.start();
  const address = internals.http.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const call = async (method: string, route: string, body?: unknown, key?: string) => {
    const response = await fetch(base + route, { method, headers: { authorization: "Bearer write", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, store: internals.controlStore, async close() { await control.stop(); store.db.close(); rmSync(path, { force: true }); } };
}

test("notice targets name a connector, a room and optionally a thread", () => {
  assert.deepEqual(parseNoticeTarget("matrix:!a:example.org"), { connector: "matrix", roomId: "!a:example.org", threadId: "" });
  assert.deepEqual(parseNoticeTarget("matrix:!a:example.org#$root"), { connector: "matrix", roomId: "!a:example.org", threadId: "$root" });
  assert.equal(parseNoticeTarget("!a:example.org"), undefined);
  assert.equal(parseNoticeTarget("matrix:"), undefined);
});

test("lifecycle events read as the operator expects them; a burst is folded, outcomes never are", () => {
  assert.equal(formatOperatorEvent({ type: "control_plane.up", version: "0.7.42", latest_bridge_version: "0.7.40" }),
    "🟢 控制面已启动 · 版本 0.7.42 · 广播最新 0.7.40");
  assert.equal(formatOperatorEvent({ type: "bridge_update.status", machine_id: "hal", phase: "completed", current_version: "0.7.39", latest_version: "0.7.40" }),
    "🔄 更新完成：hal · 0.7.39 → 0.7.40");
  assert.equal(formatOperatorEvent({ type: "bridge.offline", machine_id: "gqx" }), "🔴 gqx 离线");

  const posted: string[] = [];
  let now = 1_000;
  const store = { createNotice: (input: { text: string }) => { posted.push(input.text); } } as unknown as AgentControlStore;
  const notices = new OperatorNotices(store, { connector: "matrix", roomId: "!ops", threadId: "" }, 60_000, () => now);
  notices.notify({ type: "bridge.offline", machine_id: "a" });
  notices.notify({ type: "bridge.offline", machine_id: "b" });
  notices.notify({ type: "bridge.online", machine_id: "a" });
  notices.notify({ type: "control_plane.up", version: "1.0.0" });
  now += 60_000;
  notices.notify({ type: "bridge.online", machine_id: "b" });
  assert.deepEqual(posted, ["🔴 a 离线", "🟢 控制面已启动 · 版本 1.0.0",
    "🟢 b 上线\n🧮 上一窗口已合并 2 条通知（bridge.offline×1、bridge.online×1）"]);
});

test("a queued notice reaches the stream, is idempotent per key, and records where it was posted", async () => {
  const f = await fixture();
  try {
    // Starting announces itself in the operator's room.
    const [up] = f.store.notices({ connector: "matrix", limit: 10 });
    assert.equal(up?.text, "🟢 控制面已启动 · 版本 9.9.9");
    assert.equal(up?.source, "control-plane"); assert.equal(up?.roomId, "!ops:example.org");

    const from = f.store.streamPosition();
    const first = await f.call("POST", "/notices", { target: "matrix:!home:example.org", text: "🧺 洗衣机快洗完了" }, "washer-1");
    assert.equal(first.status, 201);
    assert.equal(first.body.source, "control:write"); assert.equal(first.body.deliveredAt, null);
    const again = await f.call("POST", "/notices", { target: "matrix:!home:example.org", text: "🧺 洗衣机快洗完了" }, "washer-1");
    assert.equal(again.body.id, first.body.id, "a retried POST does not queue a second notice");
    const streamed = f.store.streamAfter(from).items.filter((item) => item.type === "notice.upserted");
    assert.deepEqual(streamed.map((item) => (item.payload as { id: string }).id), [first.body.id]);

    assert.equal((await f.call("POST", "/notices", { target: "nowhere", text: "x" })).status, 400);
    assert.equal((await f.call("POST", "/notices", { target: "matrix:!home:example.org", text: "x", sessionId: "missing" })).status, 404);

    let pending = (await f.call("GET", "/notices?connector=matrix&undelivered=1")).body.data;
    assert.deepEqual(pending.map((row: any) => row.id), [up!.id, first.body.id]);
    const delivered = await f.call("PUT", `/notices/${first.body.id}`, { eventId: "$posted" });
    assert.equal(delivered.body.eventId, "$posted"); assert.ok(delivered.body.deliveredAt);
    assert.equal((await f.call("PUT", `/notices/${first.body.id}`, { eventId: "$again" })).body.eventId, "$posted");
    pending = (await f.call("GET", "/notices?connector=matrix&undelivered=1")).body.data;
    assert.deepEqual(pending.map((row: any) => row.id), [up!.id]);
    const room = (await f.call("GET", `/notices?connector=matrix&roomId=${encodeURIComponent("!home:example.org")}&threadId=&after=0`)).body.data;
    assert.deepEqual(room.map((row: any) => row.text), ["🧺 洗衣机快洗完了"]);
    assert.equal((await f.call("PUT", "/notices/missing", { eventId: "$x" })).status, 404);
  } finally { await f.close(); }
});

test("known secret values never reach stored notices or events", async () => {
  const { setRedactedSecrets, decodeEventBody } = await import("../packages/database/src/index.js");
  const store = new Store(":memory:");
  const control = new AgentControlStore(store.db, { actionsMs: 1, attachmentsMs: 1 });
  setRedactedSecrets({ "shared/x#API_KEY": "sk-abcdefghijklmnop", "shared/x#SHORT": "short" });
  try {
    const notice = control.createNotice({ connector: "app", roomId: "op", text: "key is sk-abcdefghijklmnop, short stays", source: "t" });
    assert.equal(notice.text, "key is ‹secret:shared/x#API_KEY›, short stays");
    store.upsertMachine({ id: "hal", name: "hal", hostname: "hal", platform: "linux", capabilities: [] });
    store.createSession({ id: "s", machineId: "hal", agentType: "pi", projectName: "p", projectPath: "/p", matrixRoomId: "", matrixThreadId: null,
      nativeSessionId: "n", status: "working", createdAt: 1, updatedAt: 1 });
    control.appendSessionEvent({ type: "session.event", eventId: "e1", eventType: "command.completed", sessionId: "s", timestamp: 1,
      payload: { command: "cat .env", output: "API_KEY=sk-abcdefghijklmnop" } } as any);
    const row = store.db.prepare("SELECT body FROM events WHERE session_id='s'").get() as { body: unknown };
    assert.equal(decodeEventBody(row.body).output, "API_KEY=‹secret:shared/x#API_KEY›");
  } finally { setRedactedSecrets({}); store.db.close(); }
});
