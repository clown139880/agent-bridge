import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { Automations, renderTemplate, validateDefinition, verifySignature } from "../apps/control-plane/src/automations.js";
import { nextCron, parseCron } from "../apps/control-plane/src/cron.js";

const settle = async (check: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return;
  throw new Error("timed out");
};

function fixture(files: Record<string, string>, extra: { secrets?: string; online?: boolean; reviewer?: (p: any) => Promise<{ decision: "allow" | "human"; reason: string }> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "automations-"));
  const dir = join(root, "automations");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
    if (path.endsWith(".sh")) chmodSync(join(dir, path), 0o755);
  }
  if (extra.secrets) writeFileSync(join(root, "secrets.env"), extra.secrets);
  const store = new Store(":memory:");
  store.upsertMachine({ id: "hal", name: "hal", hostname: "hal", platform: "linux", capabilities: ["pi"] });
  const control = new AgentControlStore(store.db, { actionsMs: 86_400_000, attachmentsMs: 86_400_000 });
  const dispatched: any[] = [], turns: Array<{ sessionId: string; input: string; key: string }> = [];
  let now = Date.UTC(2026, 9, 31, 0, 0);
  const automations = new Automations({ dir, scriptRoots: [], secretsFile: join(root, "secrets.env"), defaultAgent: "pi",
    operatorTarget: { connector: "app", roomId: "operator", threadId: "" }, push: false, reviewer: extra.reviewer }, {
    store: control, registry: { get: (id: string) => extra.online === false ? undefined : id === "hal" ? {} : undefined } as any,
    dispatch: (action, message) => { dispatched.push({ action, message }); },
    scopeTarget: () => ({ workerId: "pi@hal", workspace: "/root/app" }), validScope: (scope) => scope === "repo-app",
    sendTurn: (sessionId, input, key) => { if (sessionId === "gone") throw new Error("会话不存在（可能已删除）"); turns.push({ sessionId, input, key }); },
    roomTurn: async (target, input, key) => { turns.push({ sessionId: `room:${target.roomId}`, input, key }); return "room-session"; },
    now: () => now, pollMs: 10 });
  automations.reload();
  const notices = () => control.notices({ connector: "app", limit: 50 }).concat(control.notices({ connector: "matrix", limit: 50 }));
  return { automations, control, store, dispatched, turns, notices, root, advance: (ms: number) => { now += ms; },
    close: () => { store.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("cron: Shanghai wall clock, steps, ranges and the either-day rule", () => {
  const at = (iso: string) => Date.parse(iso);
  // 09:20 Shanghai is 01:20 UTC.
  assert.equal(new Date(nextCron(parseCron("20 9 * * *"), at("2026-10-31T00:00:00Z"), "Asia/Shanghai")!).toISOString(), "2026-10-31T01:20:00.000Z");
  assert.equal(new Date(nextCron(parseCron("0 9-23/2 * * *"), at("2026-10-31T01:00:00Z"), "Asia/Shanghai")!).toISOString(), "2026-10-31T03:00:00.000Z");
  // Saturday 2026-10-31; next Saturday 10:00 after it is 11-07.
  assert.equal(new Date(nextCron(parseCron("0 10 * * 6"), at("2026-10-31T03:00:00Z"), "Asia/Shanghai")!).toISOString(), "2026-11-07T02:00:00.000Z");
  assert.equal(new Date(nextCron(parseCron("45 9 1 * *"), at("2026-10-31T03:00:00Z"), "Asia/Shanghai")!).toISOString(), "2026-11-01T01:45:00.000Z");
  assert.throws(() => parseCron("61 * * * *"));
  assert.throws(() => parseCron("* * *"));
});

test("templates fill dotted fields; definitions are checked", () => {
  assert.equal(renderTemplate("{emoji} {title}\n{detail.a}{missing}", { emoji: "✅", title: "完成", detail: { a: 1 } }), "✅ 完成\n1");
  assert.throws(() => validateDefinition({ title: "x", trigger: {} }), /exactly one/);
  assert.throws(() => validateDefinition({ title: "x", trigger: { schedule: { cron: "0 9 * * *" } } }), /a script, an agent, a session, a room or a template/);
  assert.throws(() => validateDefinition({ title: "x", trigger: { schedule: { everyMinutes: 5 } }, template: "t", deliver: ["nowhere"] }), /deliver/);
  assert.ok(validateDefinition({ title: "x", trigger: { webhook: { secretRef: "HOOK" } }, template: "{text}", deliver: ["app", "matrix:!a:b"] }));
});

test("webhook signatures: GitHub, GitLab token and Hermes V2", () => {
  const body = Buffer.from('{"a":1}'), secret = "s3";
  const hex = (data: string) => createHmac("sha256", secret).update(data).digest("hex");
  assert.ok(verifySignature({ "x-hub-signature-256": `sha256=${hex('{"a":1}')}` }, body, secret, Date.now()));
  assert.ok(!verifySignature({ "x-hub-signature-256": "sha256=00" }, body, secret, Date.now()));
  assert.ok(verifySignature({ "x-gitlab-token": "s3" }, body, secret, Date.now()));
  const ts = String(Math.floor(Date.now() / 1000));
  assert.ok(verifySignature({ "x-webhook-signature-v2": hex(`${ts}.{"a":1}`), "x-webhook-timestamp": ts }, body, secret, Date.now()));
  assert.ok(!verifySignature({ "x-webhook-signature-v2": hex(`${ts}.{"a":1}`), "x-webhook-timestamp": ts }, body, secret, Date.now() + 3_600_000));
  assert.ok(!verifySignature({}, body, secret, Date.now()));
});

test("a due script runs once, its output is delivered, [SILENT] and failures are not, and a missed run is recorded", async () => {
  const f = fixture({
    "jmyd/daily/automation.yaml": "title: 日报\ntrigger:\n  schedule: { cron: \"20 9 * * *\" }\nscript: { path: report.sh }\ndeliver: [\"matrix:!room:x\"]\n",
    "jmyd/daily/report.sh": "#!/bin/sh\necho \"今日销售 $AUTOMATION_ID\"\n",
    "jmyd/quiet/automation.yaml": "title: 安静\ntrigger:\n  schedule: { everyMinutes: 30 }\nscript: { path: quiet.sh }\n",
    "jmyd/quiet/quiet.sh": "#!/bin/sh\necho '[SILENT]'\n",
    "jmyd/broken/automation.yaml": "title: 坏的\ntrigger:\n  schedule: { everyMinutes: 30 }\nscript: { path: broken.sh }\n",
    "jmyd/broken/broken.sh": "#!/bin/sh\necho oops >&2\nexit 3\n",
    "jmyd/escape/automation.yaml": "title: 越界\ntrigger:\n  schedule: { everyMinutes: 30 }\nscript: { path: /bin/true }\n",
  });
  try {
    const list = Object.fromEntries(f.automations.list().map((row) => [row.id, row]));
    assert.match(String(list.escape!.error), /outside/);
    assert.equal(new Date(Number(list.daily!.nextAt)).toISOString(), "2026-10-31T01:20:00.000Z");
    f.advance(80 * 60_000); f.automations.tick();
    await settle(() => f.automations.runs("daily")[0]?.status === "ok" && f.automations.runs("broken")[0]?.status === "failed" && f.automations.runs("quiet")[0]?.status === "silent");
    const texts = f.notices().map((row) => row.text);
    assert.deepEqual(texts.filter((text) => text.startsWith("今日")), ["今日销售 daily\n".trim()]);
    assert.ok(texts.some((text) => /定时任务失败：坏的\n脚本退出码 3：oops/.test(text)));
    assert.ok(!texts.some((text) => text.includes("SILENT")));
    f.automations.tick();
    assert.equal(f.automations.runs("daily").length, 1, "not run twice for one due time");
    // Two days later after a long outage: the 09:20 slot is more than an hour past: missed, not run.
    f.advance(2 * 86_400_000); f.automations.tick();
    assert.equal(f.automations.runs("daily")[0]!.status, "missed");
  } finally { f.close(); }
});

test("a signed webhook renders its template once; a redelivery and a bad signature do not run", async () => {
  const f = fixture({ "velvet-room/gen-done/automation.yaml": "title: 出片\ntrigger:\n  webhook: { secretRef: HOOK_GEN, template: \"✅ {message}\" }\ndeliver: [\"matrix:!velvet:x\"]\n" },
    { secrets: "HOOK_GEN=tok-1\n" });
  try {
    const body = Buffer.from(JSON.stringify({ message: "第 3 镜完成" }));
    assert.equal((await f.automations.hook("gen-done", { "x-gitlab-token": "wrong" }, body)).status, 401);
    assert.equal((await f.automations.hook("nope", { "x-gitlab-token": "tok-1" }, body)).status, 404);
    const first = await f.automations.hook("gen-done", { "x-gitlab-token": "tok-1" }, body);
    assert.equal(first.status, 202); assert.ok(first.body.runId);
    assert.equal((await f.automations.hook("gen-done", { "x-gitlab-token": "tok-1" }, body)).body.duplicate, true);
    await settle(() => f.automations.runs("gen-done")[0]?.status === "ok");
    assert.deepEqual(f.notices().map((row) => [row.roomId, row.text]), [["!velvet:x", "✅ 第 3 镜完成"]]);
  } finally { f.close(); }
});

test("an agent task starts a session with the script's output and delivers its answer as the session's notice", async () => {
  const f = fixture({
    "repo-app/news/automation.yaml": "title: 速递\ntrigger:\n  schedule: { everyMinutes: 60 }\nscript: { path: prep.sh }\nagent:\n  prompt: 按偏好筛选。\ndeliver: [\"matrix:!news:x\"]\n",
    "repo-app/news/prep.sh": "#!/bin/sh\necho 'HN: 一条新闻'\n",
  });
  try {
    const runId = f.automations.runNow("news");
    await settle(() => f.dispatched.length === 1);
    const { action, message } = f.dispatched[0]!;
    assert.equal(message.type, "action.create_session"); assert.equal(message.agentType, "pi");
    assert.equal(message.projectPath, "/root/app"); assert.equal(message.memoryScope, "repo-app");
    assert.equal(message.input, "[脚本输出]\nHN: 一条新闻\n\n按偏好筛选。");
    f.store.createSession({ id: "s1", machineId: "hal", agentType: "pi", projectName: "app", projectPath: "/root/app",
      matrixRoomId: "", matrixThreadId: null, nativeSessionId: "n1", status: "working", createdAt: Date.now(), updatedAt: Date.now() });
    f.control.completeAction({ type: "action.result", actionId: action.actionId, kind: "create_session", status: "succeeded", sessionId: "s1", timestamp: Date.now() } as any);
    const event = (id: string, type: string, payload: Record<string, unknown>) => f.control.appendSessionEvent({ type: "session.event", eventId: id,
      eventType: type as "turn.completed", sessionId: "s1", turnId: "t1", timestamp: Date.now(), payload });
    event("m1", "message.completed", { role: "assistant", text: "今日要闻：一条" });
    event("t1", "turn.completed", {});
    await settle(() => f.automations.runs("news")[0]?.status === "ok");
    const run = f.automations.runs("news")[0]!;
    assert.equal(run.id, runId); assert.equal(run.sessionId, "s1");
    const [notice] = f.notices();
    assert.equal(notice?.text, "今日要闻：一条"); assert.equal(notice?.sessionId, "s1", "replying in its thread continues the run's session");
  } finally { f.close(); }
});

test("an agent proposes a task; only the human's decision writes it, and it is then scheduled", () => {
  const f = fixture({});
  try {
    const definition = { title: "提醒", trigger: { schedule: { cron: "0 10 * * 6" } }, template: "该打针了" };
    assert.throws(() => f.automations.propose({ action: "update", id: "remind", definition }, "agent:pi"), /not found/);
    const proposal = f.automations.propose({ action: "create", id: "remind", scope: "household", definition, reason: "用户要每周提醒" }, "agent:pi");
    assert.equal(proposal.status, "pending");
    assert.equal(f.automations.list().length, 0, "nothing is scheduled before the human confirms");
    assert.ok(f.notices().some((row) => row.text.startsWith("🗓️ 定时任务提案：新建 提醒") && row.level === "alert"));
    const applied = f.automations.decide(proposal.id, "allow", "control:write");
    assert.equal(applied.status, "applied");
    assert.deepEqual(f.automations.list().map((row) => [row.id, row.scope, row.title]), [["remind", "household", "提醒"]]);
    assert.throws(() => f.automations.decide(proposal.id, "allow", "control:write"), /applied/);
  } finally { f.close(); }
});

test("over HTTP: hooks are served at /hooks/<id>; an agent may propose but only the human confirms", async () => {
  const { ControlPlane } = await import("../apps/control-plane/src/server.js");
  const root = mkdtempSync(join(tmpdir(), "automations-http-")), dir = join(root, "automations"), db = join(root, "cp.sqlite");
  mkdirSync(join(dir, "home", "washer"), { recursive: true });
  writeFileSync(join(dir, "home", "washer", "automation.yaml"), "title: 洗衣机\ntrigger:\n  webhook: { secretRef: HOOK_WASHER, template: \"🧺 {text}\" }\n");
  writeFileSync(join(root, "secrets.env"), "HOOK_WASHER=w\n");
  const store = new Store(db);
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, controlApiWriteToken: "human",
    agents: [{ name: "pi", token: "agent", role: "agent" }],
    automations: { dir, scriptRoots: [], secretsFile: join(root, "secrets.env"), defaultAgent: "pi", push: false, hookBases: ["http://127.0.0.1:8787", "http://lan:8787"] },
    sse: { keepaliveMs: 50, pollMs: 5, maxBackpressure: 3 } });
  await control.start();
  try {
    const address = (control as any).http.address();
    const base = `http://127.0.0.1:${address.port}`;
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const hook = await fetch(`${base}/webhooks/washer`, { method: "POST", headers: { "x-gitlab-token": "w", "content-type": "application/json" }, body: '{"text":"快洗完了"}' });
    assert.equal(hook.status, 202);
    assert.equal((await fetch(`${base}/hooks/washer`, { method: "POST", body: "{}" })).status, 401);
    await settle(() => (control as any).controlStore.notices({ connector: "app", limit: 10 }).some((row: any) => row.text === "🧺 快洗完了"));

    const proposed = await call("agent", "POST", "/api/v1/automations/proposals",
      { action: "create", id: "remind", scope: "home", definition: { title: "提醒", trigger: { schedule: { cron: "0 10 * * 6" } }, template: "打针" } });
    assert.equal(proposed.status, 201);
    assert.equal((await call("agent", "POST", `/api/v1/automations/proposals/${proposed.body.id}/decision`, { choice: "allow" })).status, 403);
    const decided = await call("human", "POST", `/api/v1/automations/proposals/${proposed.body.id}/decision`, { choice: "allow" });
    assert.equal(decided.body.status, "applied");
    const list = await call("agent", "GET", "/api/v1/automations");
    assert.deepEqual(list.body.data.find((row: any) => row.id === "washer").hooks, ["http://127.0.0.1:8787/hooks/washer", "http://lan:8787/hooks/washer"], "callers are told where to post");
    assert.deepEqual(list.body.data.map((row: any) => row.id).sort(), ["remind", "washer"]);

    // The human edits and deletes directly, in YAML; an agent may not.
    const detail = await call("human", "GET", "/api/v1/automations/remind");
    assert.match(detail.body.yaml, /^title: 提醒/);
    assert.equal((await call("agent", "POST", "/api/v1/automations/remind/edit", { yaml: "title: x" })).status, 403);
    assert.equal((await call("human", "POST", "/api/v1/automations/remind/edit", { yaml: "title: [" })).body.error.code, "invalid_definition");
    const edited = await call("human", "POST", "/api/v1/automations/remind/edit", { yaml: detail.body.yaml.replace("提醒", "每周提醒") });
    assert.equal(edited.body.status, "applied");
    assert.equal((await call("human", "GET", "/api/v1/automations/remind")).body.title, "每周提醒");
    // Only the deliver list changes; the rest of the definition stays.
    assert.equal((await call("agent", "POST", "/api/v1/automations/remind/deliver", { deliver: ["call:simon"] })).status, 403);
    assert.equal((await call("human", "POST", "/api/v1/automations/remind/deliver", { deliver: ["matrix:!a:example.org", "call:simon"] })).body.status, "applied");
    const delivered = (await call("human", "GET", "/api/v1/automations/remind")).body;
    assert.deepEqual([delivered.definition.deliver, delivered.title], [["matrix:!a:example.org", "call:simon"], "每周提醒"]);
    assert.equal((await call("human", "POST", "/api/v1/automations/remind/deliver", { deliver: ["nowhere"] })).body.error.code, "invalid_definition");
    assert.deepEqual((await call("human", "GET", "/api/v1/notice-targets")).body.data[0], { target: "app", name: "App 推送", kind: "app" });
    assert.equal((await call("human", "POST", "/api/v1/automations/remind/delete", {})).body.status, "applied");
    assert.deepEqual((await call("human", "GET", "/api/v1/automations")).body.data.map((row: any) => row.id), ["washer"]);
  } finally { await control.stop(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a script that exits before reading its input does not take the process down", async () => {
  const big = "x".repeat(4 * 1024 * 1024);
  const f = fixture({ "home/quick/automation.yaml": "title: 快\ntrigger:\n  webhook: { secretRef: HOOK_Q }\nscript: { path: quick.sh }\n",
    "home/quick/quick.sh": "#!/bin/sh\necho done\n" }, { secrets: "HOOK_Q=q\n" });
  try {
    for (let i = 0; i < 5; i++) f.automations.runNow("quick", { big });
    await settle(() => f.automations.runs("quick").some((run) => run.status === "ok"));
  } finally { f.close(); }
});

test("a webhook without secretRef is open", async () => {
  const f = fixture({ "home/open/automation.yaml": "title: 开放\ntrigger:\n  webhook: { template: \"{text}\" }\n" });
  try {
    assert.equal((await f.automations.hook("open", {}, Buffer.from('{"text":"hi"}'))).status, 202);
    await settle(() => f.automations.runs("open")[0]?.status === "ok");
  } finally { f.close(); }
});

test("one hook, old names as aliases; ?continue=1 decides at dispatch time whether an agent picks it up", async () => {
  const f = fixture({ "repo-app/velvet/automation.yaml": [
    "title: 回调", "trigger:", "  webhook:", "    template: \"{text}\"", "    aliases: [gen-done, \"gen-next?continue=1\"]",
    "script: { path: v.sh }", "agent:", "  when: \"{query.continue}\"", "  prompt: \"接着做：{text}\"", "deliver: [\"matrix:!v:x\"]", ""].join("\n"),
    "repo-app/velvet/v.sh": "#!/bin/sh\necho '{\"text\":\"第 3 镜完成\"}'\n" });
  try {
    assert.equal((await f.automations.hook("velvet", {}, Buffer.from("{}"))).status, 202);
    await settle(() => f.automations.runs("velvet")[0]?.status === "ok");
    assert.deepEqual(f.notices().map((row) => row.text), ["第 3 镜完成"]);
    assert.equal(f.dispatched.length, 0, "no agent without ?continue=1");
    assert.equal((await f.automations.hook("gen-next", {}, Buffer.from('{"n":1}'))).status, 202);
    await settle(() => f.dispatched.length === 1);
    assert.equal(f.dispatched[0]!.message.input, "接着做：第 3 镜完成");
    assert.equal((await f.automations.hook("velvet", {}, Buffer.from('{"n":2}'), { continue: "1" })).status, 202);
    await settle(() => f.automations.runs("velvet").some((run) => run.status === "skipped"), 3_000);
    assert.equal((await f.automations.hook("nope", {}, Buffer.from("{}"))).status, 404);
    const { action } = f.dispatched[0]!;
    f.control.completeAction({ type: "action.result", actionId: action.actionId, kind: "create_session", status: "failed",
      error: { code: "x", message: "stop", retryable: false }, timestamp: Date.now() } as any);
    await settle(() => !f.automations.runs("velvet").some((run) => run.status === "running"));
  } finally { f.close(); }
});

test("a one-time task wakes its session at the time, with its reminder sent first, and is then done", async () => {
  const f = fixture({
    "guadao/check/automation.yaml": "title: 挂刀看价\ntrigger: { at: \"2026-10-31 08:30\" }\nsession: { id: codex-1, note: 看两把红线当前价格 }\ndeliver: [app]\n",
    "blg/remind/automation.yaml": "title: BLG 赛前\ntrigger: { at: \"2026-10-31 08:30\" }\nsession: { id: claude-2, note: 先跑市场情况 }\n",
    "x/gone/automation.yaml": "title: 已删\ntrigger: { at: \"2026-10-31 08:30\" }\nsession: { id: gone }\n",
  });
  try {
    assert.equal(f.automations.get("check")!.nextAt, Date.UTC(2026, 9, 31, 0, 30), "08:30 Shanghai");
    f.advance(31 * 60_000); f.automations.tick();
    await settle(() => f.turns.length === 2 && f.automations.get("gone")!.lastRun?.status === "failed");
    assert.deepEqual(f.turns.map((t) => t.sessionId).sort(), ["claude-2", "codex-1"]);
    assert.match(f.turns.find((t) => t.sessionId === "codex-1")!.input, /^\[约定的时间到了 · 挂刀看价\][\s\S]*看两把红线当前价格/);
    const sent = f.notices().map((n) => n.text);
    assert.ok(sent.includes("⏰ 挂刀看价\n看两把红线当前价格"), "deliver gets the reminder");
    assert.ok(!sent.some((t) => t.includes("BLG 赛前")), "a session task delivers nothing it does not name");
    assert.ok(sent.some((t) => t.includes("定时任务失败：已删")), "a deleted session is reported");
    f.advance(60_000); f.automations.tick(); await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.turns.length, 2, "once only");
    assert.deepEqual([f.automations.get("check")!.completed, f.automations.get("check")!.nextAt], [true, null]);
  } finally { f.close(); }
});

test("a webhook into a room posts the text, and hands it to the room's session only when it asks for an agent", async () => {
  const f = fixture({ "silas/inbox/automation.yaml": "title: Silas Grey\ntrigger: { webhook: {} }\nroom: { to: \"matrix:!silas:example.org\", text: \"{text}\", agent: \"{agent}\" }\n" });
  try {
    await f.automations.hook("inbox", {}, Buffer.from(JSON.stringify({ text: "订单 42 已发货" })));
    await f.automations.hook("inbox", { "x-request-id": "2" }, Buffer.from(JSON.stringify({ text: "订单 43 退款，需要处理", agent: true })));
    await settle(() => f.turns.length === 1 && f.automations.runs("inbox").filter((r) => r.status === "ok").length === 2);
    assert.equal(f.notices().filter((n) => n.roomId === "!silas:example.org").length, 2, "both posted, the second while the first ran");
    assert.equal(f.turns[0]!.sessionId, "room:!silas:example.org");
    assert.match(f.turns[0]!.input, /^\[系统消息 · Silas Grey\][\s\S]*订单 43 退款，需要处理$/);
    assert.equal(f.notices().filter((n) => n.connector === "app").length, 0, "nothing else is delivered");
  } finally { f.close(); }
});

test("an agent's proposal the reviewer allows takes effect at once and tells nobody; one it doubts waits with its reason", async () => {
  const f = fixture({}, { reviewer: async (p) => p.definition?.session ? { decision: "allow", reason: "唤回自己的会话" } : { decision: "human", reason: "建议拒绝：每分钟开会话" } });
  try {
    const wake = await f.automations.proposeReviewed({ action: "create", id: "remind", scope: "guadao",
      definition: { title: "挂刀看价", trigger: { at: "2026-11-06 14:00" }, session: { id: "codex-1", note: "看价格" } } }, "agent:codex@dev-windows");
    assert.deepEqual([wake.status, wake.decidedBy], ["applied", "review"]);
    assert.deepEqual(f.automations.list().map((t) => t.id), ["remind"]);
    assert.equal(f.notices().length, 0, "nobody is told");
    const busy = await f.automations.proposeReviewed({ action: "create", id: "busy", scope: "x",
      definition: { title: "刷屏", trigger: { schedule: { everyMinutes: 1 } }, agent: { prompt: "看看" } } }, "agent:pi");
    assert.deepEqual([busy.status, busy.review], ["pending", "建议拒绝：每分钟开会话"]);
    assert.match(f.notices()[0]!.text, /待你确认[\s\S]*审核员：建议拒绝：每分钟开会话/);
  } finally { f.close(); }
});
