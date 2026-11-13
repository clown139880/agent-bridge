import assert from "node:assert/strict";
import test from "node:test";
import { AgentControlStore, Store } from "../packages/database/src/index.js";
import { dayStart, Journal, localDate, programStatus, transcript } from "../apps/control-plane/src/journal.js";

const TZ = "Asia/Shanghai";
const DAY0 = Date.UTC(2026, 10, 9, 16); // 2026-11-10 00:00 in Shanghai
const at = (hours: number) => DAY0 + hours * 3_600_000;

function fixture(answers: { summary?: (user: string) => Record<string, unknown>; archive?: (user: string) => Record<string, unknown> } = {}) {
  const store = new Store(":memory:");
  store.upsertMachine({ id: "hal", name: "hal", hostname: "hal", platform: "linux", capabilities: ["claude-code"] });
  const control = new AgentControlStore(store.db, { actionsMs: 86_400_000, attachmentsMs: 86_400_000 });
  store.db.exec(`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, trigger TEXT NOT NULL,
    trigger_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, session_id TEXT, output TEXT, error TEXT)`);
  const calls: string[] = [];
  let now = at(31);
  const held: Array<{ args: Record<string, unknown>; reason: string }> = [];
  const journal = new Journal({ db: store.db, tz: TZ, now: () => now,
    reviews: { hold: (_writer, _tool, args, reason) => (held.push({ args, reason }), { id: `mr_${held.length}` }) },
    model: async (system, user) => {
      calls.push(user);
      if (system.startsWith("你是中央记忆的归档员")) return answers.archive?.(user) ?? { decisions: [] };
      return answers.summary?.(user) ?? { title: "", done: ["做完了"], next: "", waitingOnHuman: "", memory: [] };
    },
    automations: () => [{ id: "patrol", title: "巡检", schedule: { cron: "0 3 * * *", tz: TZ }, paused: false, enabled: true, deliver: [] }] });
  const session = (id: string, title: string, created = at(1), path = `/root/${id}`) => {
    store.createSession({ id, machineId: "hal", agentType: "claude-code", projectName: id, projectPath: path, matrixRoomId: "", matrixThreadId: null,
      nativeSessionId: `n-${id}`, status: "idle", createdAt: created, updatedAt: created } as any);
    store.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
  };
  let n = 0;
  const event = (sessionId: string, type: string, time: number, payload: Record<string, unknown> = {}, turnId = "t1") =>
    control.appendSessionEvent({ type: "session.event", eventId: `e${++n}`, eventType: type as "turn.completed", sessionId, turnId, timestamp: time, payload });
  const turn = (sessionId: string, turnId: string, start: number, end?: { type: string; time: number; payload?: Record<string, unknown> }, text = "好的") => {
    event(sessionId, "turn.started", start, {}, turnId);
    event(sessionId, "message.completed", start + 1000, { role: "user", text: `请做 ${turnId}` }, turnId);
    event(sessionId, "message.completed", start + 2000, { role: "assistant", text }, turnId);
    if (end) event(sessionId, end.type, end.time, end.payload ?? {}, turnId);
  };
  return { store, control, journal, calls, held, session, event, turn, advance: (ms: number) => { now += ms; } };
}

test("a day is cut at midnight in the given time zone", () => {
  assert.equal(dayStart("2026-11-10", TZ), DAY0);
  assert.equal(dayStart("2026-03-08", "America/New_York"), Date.UTC(2026, 2, 8, 5));
  assert.equal(dayStart("2026-03-09", "America/New_York"), Date.UTC(2026, 2, 9, 4), "the day after the clocks moved starts an hour earlier in UTC");
  assert.equal(localDate(DAY0 - 1, TZ), "2026-11-09");
});

test("the program decides interrupted, in progress, failed and done from the turn events", () => {
  const end = at(24);
  const t = (type: string, turn: string, time: number, reason?: string) => ({ type, turn, at: time, ...(reason ? { reason } : {}) });
  assert.equal(programStatus([t("turn.started", "a", at(1)), t("turn.completed", "a", at(2))], end, null).status, "done");
  assert.equal(programStatus([t("turn.started", "a", at(1)), t("turn.interrupted", "a", at(2))], end, null).status, "done", "a person stopped it");
  const lost = programStatus([t("turn.started", "a", at(1)), t("turn.interrupted", "a", at(2), "worker no longer owns this turn")], end, null);
  assert.equal(lost.status, "interrupted"); assert.match(lost.interruptions, /中断/);
  assert.equal(programStatus([t("turn.started", "a", at(23))], end, "a").status, "in_progress");
  assert.equal(programStatus([t("turn.started", "a", at(23))], end, null).status, "interrupted", "open, and the session no longer runs it");
  assert.equal(programStatus([t("turn.started", "a", at(23)), t("turn.completed", "a", at(25))], end, null).status, "in_progress", "ran past midnight");
  assert.equal(programStatus([t("turn.started", "a", at(1)), t("turn.failed", "a", at(2))], end, null).status, "failed");
  const resumed = programStatus([t("turn.started", "a", at(1)), t("turn.interrupted", "a", at(2), "lost"), t("turn.started", "b", at(3)), t("turn.completed", "b", at(4))], end, null);
  assert.equal(resumed.status, "done"); assert.match(resumed.interruptions, /1 次中断/);
});

test("a long transcript keeps the human's every message and drops the agent's middle replies first", () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ at: at(1) + i, role: i % 2 ? "assistant" : "user", text: `${i}:${"字".repeat(500)}` }));
  const text = transcript(messages, 6000);
  for (let i = 0; i < 20; i += 2) assert.ok(text.includes(`${i}:`), `human message ${i} kept`);
  assert.ok(text.includes("[…]")); assert.ok(text.includes("19:"), "the last turns stay");
});

test("one day: states, the open items, automation runs, and a rerun reads only what changed", async () => {
  const f = fixture({ summary: (user) => user.includes("等人") ? { title: "等人的会话", done: ["写好设计"], waitingOnHuman: "确认设计", next: "" }
    : user.includes("有下一步") ? { title: "接着做", done: ["改完一半"], next: "改另一半", waitingOnHuman: "" } : { title: "", done: ["做完了"] } });
  f.session("done1", "做完的");
  f.turn("done1", "a", at(2), { type: "turn.completed", time: at(3) });
  f.session("ask", "等人");
  f.turn("ask", "a", at(4), { type: "turn.completed", time: at(5) });
  f.session("more", "有下一步");
  f.turn("more", "a", at(6), { type: "turn.completed", time: at(7) });
  f.session("cut", "被打断的");
  f.turn("cut", "a", at(8), { type: "turn.interrupted", time: at(9), payload: { reason: "worker no longer owns this turn" } });
  f.session("old", "前一天的");
  f.turn("old", "a", at(-5), { type: "turn.completed", time: at(-4) });
  // The automation's own session only counts in the automation line.
  f.session("auto", "巡检会话", at(3));
  f.turn("auto", "a", at(3), { type: "turn.completed", time: at(3.1) });
  f.store.db.prepare("INSERT INTO automation_runs (id,automation_id,trigger,trigger_at,started_at,status,session_id,error) VALUES (?,?,?,?,?,?,?,?)")
    .run("r1", "patrol", "schedule", at(3), at(3), "failed", "auto", "超时");

  const day = await f.journal.run({ date: "2026-11-10" });
  const state = Object.fromEntries(day.sessions.map((s) => [s.id, s.status]));
  assert.deepEqual(state, { done1: "done", ask: "waiting_human", more: "in_progress", cut: "interrupted" });
  assert.equal(day.sessions.find((s) => s.id === "ask")?.title, "等人的会话");
  assert.deepEqual({ runs: day.automations.runs, failed: day.automations.failed }, { runs: 1, failed: 1 });
  assert.deepEqual(day.items.open.map((i) => i.id).sort(), ["jn-a-patrol-1110", "jn-ask-1110-human", "jn-cut-1110-interrupted", "jn-more-1110-next"]);
  assert.equal(day.usage.summarized, 4);

  const again = await f.journal.run({ date: "2026-11-10" });
  assert.deepEqual({ summarized: again.usage.summarized, reused: again.usage.reused }, { summarized: 0, reused: 4 }, "nothing changed, nothing read again");
  assert.equal(again.items.open.length, 4, "a rerun does not double an item");

  // The next day the interrupted session goes on and the patrol succeeds: both close by themselves.
  f.turn("cut", "b", at(26), { type: "turn.completed", time: at(27) });
  f.store.db.prepare("INSERT INTO automation_runs (id,automation_id,trigger,trigger_at,started_at,status) VALUES (?,?,?,?,?,?)").run("r2", "patrol", "schedule", at(27), at(27), "ok");
  f.advance(86_400_000);
  const next = await f.journal.run({ date: "2026-11-11" });
  assert.deepEqual(next.items.closed.map((i) => i.id).sort(), ["jn-a-patrol-1110", "jn-cut-1110-interrupted"]);
  assert.ok(next.items.closed.every((i) => i.closedBy === "auto"));
  assert.equal(next.sessions.find((s) => s.id === "cut")?.status, "done");

  const closed = f.journal.close("jn-ask-1110-human");
  assert.equal(closed.closedBy, "human");
  assert.deepEqual(f.journal.items({ open: true }).map((i) => i.id), ["jn-more-1110-next"]);
  assert.throws(() => f.journal.close("nope"), /not found/);
});

test("a schedule that came due with no run at all counts as missed", async () => {
  const f = fixture();
  const day = await f.journal.run({ date: "2026-11-10" });
  assert.equal(day.automations.missed, 1);
  assert.deepEqual(day.items.open.map((i) => i.id), ["jn-a-patrol-1110"]);
});

test("memory candidates are filed; a conflict, an unnamed scope and a left-out candidate go to the human", async () => {
  const f = fixture({
    summary: (user) => ({ title: "", done: ["做完了"], memory: user.includes("新目录") ? [{ kind: "rule", value: "在挂刀里先查价", evidence: "10:00「先查价」" }]
      : [{ kind: "rule", value: "测试先跑单个文件", evidence: "09:00「先跑单个」" }, { kind: "rule", value: "提交前不跑全量", evidence: "09:01「别跑全量」" },
        { kind: "fact", value: "被漏掉的", evidence: "" }] }),
    // Each project's candidates come in their own call, numbered from 0.
    archive: (user) => user.includes("新目录") ? {
      decisions: [{ candidate: [0], action: "project", topic: "check-price", kind: "rule", value: "在挂刀里先查价", reason: "" }],
      newScopes: [{ workspace: "/root/新目录", id: "steam-trading", title: "Steam 挂刀" }],
    } : {
      decisions: [
        { candidate: 0, action: "project", topic: "single-test-first", kind: "rule", value: "先跑单个测试文件", pin: false, conflict: "", reason: "纠正" },
        { candidate: 1, action: "project", topic: "full-tests", kind: "rule", value: "提交前不跑全量", conflict: "full-tests/rule 要求跑全量", reason: "" },
      ],
    } });
  f.session("a", "项目会话");
  f.store.db.prepare("UPDATE sessions SET group_key=?, group_title=? WHERE id='a'").run("scope\x1frepo-app", "App");
  f.turn("a", "a", at(2), { type: "turn.completed", time: at(3) });
  f.session("b", "新目录", at(4), "/root/新目录");
  f.turn("b", "a", at(4), { type: "turn.completed", time: at(5) });
  const day = await f.journal.run({ date: "2026-11-10" });
  const [written, conflict, created, missing] = day.memory.decisions;
  assert.deepEqual({ action: written?.action, scope: written?.scope, derivedFrom: written?.derivedFrom }, { action: "project", scope: "repo-app", derivedFrom: ["session:a"] });
  assert.equal(conflict?.action, "human");
  assert.equal(created?.scope, "steam-trading");
  assert.deepEqual(created?.create, { machine_id: "hal", cwd: "/root/新目录", scope_hint: "steam-trading", title: "Steam 挂刀" });
  assert.deepEqual({ action: missing?.action, value: missing?.value }, { action: "human", value: "被漏掉的" });
  // The conflict can be written as it stands, so it waits in the review queue; the left-out one has no topic.
  assert.deepEqual(f.held.map((h) => [h.args.scope, h.args.topic]), [["repo-app", "full-tests"]]);
  assert.match(f.held[0]!.reason, /冲突/);
  assert.equal(conflict?.review, "mr_1");
  assert.equal(missing?.review, undefined);
  assert.deepEqual(day.items.open.map((i) => i.kind), ["automation"], "memory never lands in the notebook's items");

  const calls = f.calls.length;
  await f.journal.run({ date: "2026-11-10" });
  assert.equal(f.calls.length, calls, "the same candidates are not filed twice");
});

test("a batch whose answer breaks fails only its own candidates, and the day is filed again next run", async () => {
  let broken = true;
  const f = fixture({
    summary: (user) => ({ title: "", done: ["做完了"], memory: [{ kind: "rule", value: user.includes("坏") ? "坏批次的规则" : "好批次的规则", evidence: "" }] }),
    archive: (user) => {
      if (user.includes("坏批次") && broken) throw new Error("bad JSON");
      return { decisions: [{ candidate: 0, action: "project", topic: "a-rule", kind: "rule", value: "规则", reason: "" }] };
    } });
  for (const [id, scope] of [["good", "repo-good"], ["bad", "repo-bad"]] as const) {
    f.session(id, id === "bad" ? "坏" : "好");
    f.store.db.prepare("UPDATE sessions SET group_key=?, group_title=? WHERE id=?").run(`scope\x1f${scope}`, scope, id);
    f.turn(id, "a", at(2), { type: "turn.completed", time: at(3) });
  }
  const day = await f.journal.run({ date: "2026-11-10" });
  assert.deepEqual(day.memory.decisions.map((d) => [d.scope, d.action]).sort(), [["repo-bad", "human"], ["repo-good", "project"]]);
  broken = false;
  const again = await f.journal.run({ date: "2026-11-10" });
  assert.ok(again.memory.decisions.every((d) => d.action === "project"), "not cached while a batch failed");
  assert.equal(f.held.length, 0, "a failed batch is filed again, not handed to the human");
});

test("a bad date or time zone is refused", async () => {
  const f = fixture();
  await assert.rejects(() => f.journal.run({ date: "2026-13-40" }), /YYYY-MM-DD/);
  await assert.rejects(() => f.journal.run({ date: "2027-01-01" }), /not started/);
  await assert.rejects(() => f.journal.run({ tz: "Mars/Base" }), /time zone/);
});
