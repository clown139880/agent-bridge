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

function fixture(files: Record<string, string>, extra: { secrets?: string; online?: boolean } = {}) {
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
  const dispatched: any[] = [];
  let now = Date.UTC(2026, 9, 31, 0, 0);
  const automations = new Automations({ dir, scriptRoots: [], secretsFile: join(root, "secrets.env"), defaultAgent: "pi",
    operatorTarget: { connector: "app", roomId: "operator", threadId: "" }, push: false }, {
    store: control, registry: { get: (id: string) => extra.online === false ? undefined : id === "hal" ? {} : undefined } as any,
    dispatch: (action, message) => { dispatched.push({ action, message }); },
    scopeTarget: () => ({ workerId: "pi@hal", workspace: "/root/app" }), validScope: (scope) => scope === "repo-app",
    now: () => now, pollMs: 10 });
  automations.reload();
  const notices = () => control.notices({ connector: "app", limit: 50 }).concat(control.notices({ connector: "matrix", limit: 50 }));
  return { automations, control, store, dispatched, notices, root, advance: (ms: number) => { now += ms; },
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
  assert.throws(() => validateDefinition({ title: "x", trigger: { schedule: { cron: "0 9 * * *" } } }), /script, an agent or a template/);
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
    assert.equal(f.automations.hook("gen-done", { "x-gitlab-token": "wrong" }, body).status, 401);
    assert.equal(f.automations.hook("nope", { "x-gitlab-token": "tok-1" }, body).status, 404);
    const first = f.automations.hook("gen-done", { "x-gitlab-token": "tok-1" }, body);
    assert.equal(first.status, 202); assert.ok(first.body.runId);
    assert.equal(f.automations.hook("gen-done", { "x-gitlab-token": "tok-1" }, body).body.duplicate, true);
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
    automations: { dir, scriptRoots: [], secretsFile: join(root, "secrets.env"), defaultAgent: "pi", push: false },
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
    assert.deepEqual(list.body.data.map((row: any) => row.id).sort(), ["remind", "washer"]);
  } finally { await control.stop(); store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
