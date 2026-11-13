import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import pino from "pino";
import type { AgentMemory } from "@agent-bridge/agent-memory";
import { decodeEventBody } from "@agent-bridge/database";
import { nextCron, parseCron } from "./cron.js";
import type { ReviewModel } from "./review-model.js";

const log = pino({ name: "journal" });
const DAY = 86_400_000;
/** A session created this close to an automation run's start is that run's own session. */
const AUTOMATION_SESSION_MS = 120_000;

/**
 * The work journal (docs/work-journal-design.zh.md): what each session and each automation did on one
 * day, read from this database. The program decides the state; the model only writes the summary, says
 * whether the agent waits on the human or has a next step, and files the human's corrections as memory
 * decisions. A rerun of the same day reads again only the sessions whose view revision moved. Open
 * items stay in a ledger across days until the session moves on or the human ticks them off.
 * Rendering into a notebook and writing the memory belong to the caller.
 */

export type JournalStatus = "done" | "in_progress" | "waiting_human" | "interrupted" | "failed";
export type ItemKind = "next" | "human" | "interrupted" | "failed" | "memory" | "automation";

export interface JournalSession {
  id: string; title: string; workerId: string; machineId: string; path: string;
  scope: { id: string; title: string } | null; status: JournalStatus; done: string[]; next: string; waitingOnHuman: string;
  interruptions: string; pending: number; error?: string;
}

export interface MemoryCandidate { session: string; kind: string; value: string; evidence: string }

/** One write the caller makes, or one the human has to decide (`action` human). */
export interface MemoryDecision {
  candidates: number[]; action: "project" | "global" | "skip" | "human";
  scope: string; topic: string; kind: string; value: string; pin: boolean; reason: string; conflict: string;
  /** The provisional scope to create first: memory `scope` with `create: true`. */
  create?: { machine_id: string; cwd: string; repository?: string; scope_hint: string; title: string };
  derivedFrom: string[];
}

export interface JournalItem {
  id: string; date: string; kind: ItemKind; title: string; scope: string | null; sessionId: string | null; automationId: string | null;
  openedAt: number; closedAt: number | null; closedBy: "auto" | "human" | null;
}

export interface AutomationDay {
  tasks: number; runs: number; ok: number; failed: number; silent: number; missed: number;
  failures: Array<{ id: string; title: string; status: "failed" | "missed"; at: number; error: string; delivered: boolean }>;
}

export interface JournalRun {
  date: string; tz: string; window: { from: number; to: number };
  sessions: JournalSession[]; automations: AutomationDay;
  memory: { candidates: MemoryCandidate[]; decisions: MemoryDecision[] };
  items: { open: JournalItem[]; closed: JournalItem[] };
  usage: { summarized: number; reused: number };
}

export interface AutomationInfo { id: string; title: string; schedule: { cron?: string; tz?: string } | null; paused: boolean; enabled: boolean; deliver: string[] }

export interface JournalOptions {
  db: DatabaseSync;
  /** jsonModel(); without it every summary falls back to the program's view. */
  model?: ReviewModel;
  memory?: AgentMemory;
  automations?: () => AutomationInfo[];
  /** Time zone a day is cut in when the caller names none. */
  tz: string;
  now?: () => number;
}

export class JournalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface SessionRow { id: string; title: string | null; machine_id: string; agent_type: string; project_path: string; project_identity: string | null;
  group_key: string | null; group_title: string | null; view_revision: number; active_turn_id: string | null }
interface Turn { type: string; turn: string | null; at: number; reason?: string }
interface Message { at: number; role: string; text: string }
interface Summary { title?: string; done?: string[]; next?: string; waitingOnHuman?: string; memory?: Array<{ kind?: string; value?: string; evidence?: string }>; error?: string }

const AGENT: Record<string, string> = { "codex-cli": "codex", "claude-code": "claude", pi: "pi" };

export class Journal {
  private readonly now: () => number;
  private running = new Map<string, Promise<JournalRun>>();

  constructor(private readonly options: JournalOptions) {
    this.now = options.now ?? Date.now;
    options.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_sessions (date TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
        summary TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (date, session_id));
      CREATE TABLE IF NOT EXISTS journal_archives (date TEXT PRIMARY KEY, candidates_hash TEXT NOT NULL, decisions TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_items (id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        scope TEXT, session_id TEXT, automation_id TEXT, window_end INTEGER NOT NULL, opened_at INTEGER NOT NULL,
        closed_at INTEGER, closed_by TEXT);
      CREATE INDEX IF NOT EXISTS journal_items_open_idx ON journal_items(closed_at, session_id);
    `);
  }

  /** The journal of one day (yesterday by default). One run per day at a time; a second caller waits for it. */
  async run(input: { date?: string; tz?: string } = {}): Promise<JournalRun> {
    const tz = input.tz ?? this.options.tz;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new JournalError(400, "invalid_tz", `unknown time zone ${tz}`); }
    const date = input.date ?? localDate(this.now() - DAY, tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new JournalError(400, "invalid_date", "date must be YYYY-MM-DD");
    const from = dayStart(date, tz), to = dayStart(localDate(from + DAY + 3_600_000, tz), tz);
    if (from >= this.now()) throw new JournalError(400, "invalid_date", "that day has not started");
    const key = `${date}\n${tz}`;
    const current = this.running.get(key);
    if (current) return current;
    const job = this.compute(date, tz, from, to).finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  items(filter: { open?: boolean; scope?: string; date?: string } = {}): JournalItem[] {
    const where = [filter.open ? "closed_at IS NULL" : "", filter.scope ? "scope=?" : "", filter.date ? "date=?" : ""].filter(Boolean);
    const args = [filter.scope, filter.date].filter((value): value is string => Boolean(value));
    return (this.options.db.prepare(`SELECT * FROM journal_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY opened_at DESC LIMIT 500`)
      .all(...args) as Array<Record<string, unknown>>).map(itemWire);
  }

  /** The human ticked it off. Closing a closed item changes nothing. */
  close(id: string, by: "human" | "auto" = "human"): JournalItem {
    const row = this.options.db.prepare("SELECT * FROM journal_items WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new JournalError(404, "item_not_found", "journal item not found");
    if (row.closed_at == null) this.options.db.prepare("UPDATE journal_items SET closed_at=?, closed_by=? WHERE id=?").run(this.now(), by, id);
    return itemWire(this.options.db.prepare("SELECT * FROM journal_items WHERE id=?").get(id) as Record<string, unknown>);
  }

  private async compute(date: string, tz: string, from: number, to: number): Promise<JournalRun> {
    const db = this.options.db;
    const runs = this.hasRuns();
    const ids = (db.prepare(`SELECT DISTINCT e.session_id AS id, s.created_at FROM events e JOIN sessions s ON s.id=e.session_id
      WHERE e.created_at>=? AND e.created_at<? AND e.type IN ('message.completed','turn.started')${runs ? `
        AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.session_id=s.id AND abs(s.created_at-COALESCE(r.started_at,r.trigger_at))<${AUTOMATION_SESSION_MS})` : ""}
      ORDER BY s.created_at`).all(from, to) as Array<{ id: string }>).map((row) => row.id);
    const sessions: JournalSession[] = [], candidates: MemoryCandidate[] = [];
    let summarized = 0, reused = 0;
    // One at a time: the night is long, and the model's concurrency is the live reviewer's too.
    for (const id of ids) {
      const row = db.prepare(`SELECT id,title,machine_id,agent_type,project_path,project_identity,group_key,group_title,view_revision,active_turn_id
        FROM sessions WHERE id=?`).get(id) as unknown as SessionRow | undefined;
      if (!row) continue;
      const { messages, turns } = this.read(id, from, to);
      const program = programStatus(turns, to, row.active_turn_id);
      const pending = Number((db.prepare("SELECT count(*) AS n FROM pending_requests WHERE session_id=? AND status='pending'").get(id) as { n: number }).n);
      const cached = db.prepare("SELECT revision, summary FROM journal_sessions WHERE date=? AND session_id=?").get(date, id) as { revision: number; summary: string } | undefined;
      let summary: Summary;
      if (cached && cached.revision === Number(row.view_revision)) { summary = JSON.parse(cached.summary) as Summary; reused++; }
      else {
        summary = await this.summarize(row, program, pending, messages, date);
        summarized++;
        if (!summary.error) db.prepare(`INSERT INTO journal_sessions (date,session_id,revision,summary,created_at) VALUES (?,?,?,?,?)
          ON CONFLICT(date,session_id) DO UPDATE SET revision=excluded.revision, summary=excluded.summary, created_at=excluded.created_at`)
          .run(date, id, Number(row.view_revision), JSON.stringify(summary), this.now());
      }
      const [kind, scopeId] = String(row.group_key ?? "").split("\x1f");
      const waiting = text(summary.waitingOnHuman), next = text(summary.next);
      // The model may only move a finished session to waiting or in progress; the program's other states stand.
      const status: JournalStatus = pending ? "waiting_human" : program.status !== "done" ? program.status
        : waiting ? "waiting_human" : next ? "in_progress" : "done";
      sessions.push({ id, title: text(summary.title) || row.title || id, workerId: `${AGENT[row.agent_type] ?? row.agent_type}@${row.machine_id}`,
        machineId: row.machine_id, path: row.project_path, scope: kind === "scope" && scopeId ? { id: scopeId, title: row.group_title ?? scopeId } : null,
        status, done: Array.isArray(summary.done) ? summary.done.map(String).filter(Boolean) : [], next, waitingOnHuman: waiting,
        interruptions: program.interruptions, pending, ...(summary.error ? { error: summary.error } : {}) });
      for (const item of Array.isArray(summary.memory) ? summary.memory : [])
        if (text(item.value)) candidates.push({ session: id, kind: text(item.kind) || "rule", value: text(item.value), evidence: text(item.evidence) });
    }
    const decisions = await this.archive(date, candidates, sessions);
    const automations = this.automationDay(from, to);
    const closed = this.ledger(date, to, sessions, decisions, automations, candidates);
    return { date, tz, window: { from, to }, sessions, automations, memory: { candidates, decisions },
      items: { open: this.items({ open: true }), closed }, usage: { summarized, reused } };
  }

  private read(sessionId: string, from: number, to: number): { messages: Message[]; turns: Turn[] } {
    const rows = this.options.db.prepare(`SELECT type, turn_id, created_at, body FROM events WHERE session_id=? AND created_at>=?
      AND type IN ('message.completed','turn.started','turn.completed','turn.failed','turn.interrupted') ORDER BY created_at, id`)
      .all(sessionId, from) as Array<{ type: string; turn_id: string | null; created_at: number; body: unknown }>;
    const messages: Message[] = [], turns: Turn[] = [];
    for (const row of rows) {
      const body = decodeEventBody(row.body);
      if (row.type === "message.completed") {
        if (row.created_at < to && (body.role === "user" || body.role === "assistant") && typeof body.text === "string" && body.text.trim())
          messages.push({ at: Number(row.created_at), role: String(body.role), text: body.text });
      } else turns.push({ type: row.type, turn: row.turn_id, at: Number(row.created_at), ...(typeof body.reason === "string" ? { reason: body.reason } : {}) });
    }
    return { messages, turns };
  }

  private async summarize(row: SessionRow, program: { status: JournalStatus; interruptions: string }, pending: number, messages: Message[], date: string): Promise<Summary> {
    const fallback = (error: string): Summary => ({ title: row.title ?? "", done: ["有进展，摘要生成失败"], next: "", waitingOnHuman: "", memory: [], error });
    if (!this.options.model) return fallback("no model");
    if (!messages.length) return { title: row.title ?? "", done: [], next: "", waitingOnHuman: "", memory: [] };
    const user = `会话：${row.title ?? "(无标题)"}\n工作目录：${row.project_path}\n程序判断的状态：${program.status}`
      + `${program.interruptions ? `（${program.interruptions}）` : ""}${pending ? `；有 ${pending} 个未处理的审批/提问` : ""}\n\n对话（${date}）：\n\n${transcript(messages)}`;
    try { return await this.options.model(summarySystem(date.slice(5)), user, 10_500) as Summary; }
    catch (error) {
      log.warn({ session: row.id, error: error instanceof Error ? error.message : String(error) }, "Journal summary failed");
      return fallback(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Files every candidate, one project's batch per call: the session's project scope by default, `_global` only when the
   * human said it holds everywhere, skip what only describes this piece of work. A contradiction, a
   * candidate the model left out and a project with no scope name go to the human.
   */
  private async archive(date: string, candidates: MemoryCandidate[], sessions: JournalSession[]): Promise<MemoryDecision[]> {
    if (!candidates.length) return [];
    const hash = createHash("sha256").update(JSON.stringify(candidates.map((c) => [c.session, c.kind, c.value]))).digest("hex");
    const db = this.options.db;
    const cached = db.prepare("SELECT candidates_hash, decisions FROM journal_archives WHERE date=?").get(date) as { candidates_hash: string; decisions: string } | undefined;
    if (cached?.candidates_hash === hash) return JSON.parse(cached.decisions) as MemoryDecision[];
    const bySession = new Map(sessions.map((s) => [s.id, s]));
    const facts = (scope: string, width: number) => {
      try { return this.options.memory?.facts(scope).filter((f) => !f.retracted && !f.validUntil).slice(0, 40)
        .map((f) => `${f.topic}/${f.kind} = ${f.value.slice(0, width)}`).join("；") || "（无）"; }
      catch { return "（无）"; }
    };
    // A busy day has dozens of candidates; one call for all of them runs out of room or breaks its JSON,
    // so they go in batches of one project's candidates each, a failed batch failing only itself.
    const batches: number[][] = [];
    const byScope = new Map<string, number[]>();
    candidates.forEach((c, i) => {
      const s = bySession.get(c.session)!, key = s.scope?.id ?? s.path;
      byScope.set(key, [...byScope.get(key) ?? [], i]);
    });
    for (const group of byScope.values()) for (let i = 0; i < group.length; i += ARCHIVE_BATCH) batches.push(group.slice(i, i + ARCHIVE_BATCH));
    const global = facts("_global", 600);
    const raws: Array<Record<string, unknown>> = [];
    const named = new Map<string, Record<string, unknown>>();
    const failures = new Map<number, string>();
    for (const batch of batches) {
      const input = batch.map((index, i) => {
        const c = candidates[index]!, s = bySession.get(c.session)!;
        return `${i}. [${c.kind}] ${c.value}\n   来源：${s.title}（${s.path}） 证据：${c.evidence}\n   项目作用域：${s.scope
          ? `${s.scope.id}（${s.scope.title}） 已有：${facts(s.scope.id, 120)}` : "不存在，需在 newScopes 里起一个"}`;
      }).join("\n");
      try {
        if (!this.options.model) throw new Error("no model");
        const answer = await this.options.model(ARCHIVE_SYSTEM, `候选：\n${input}\n\n_global 已有：${global}`, 4_000) as
          { decisions?: Array<Record<string, unknown>>; newScopes?: Array<Record<string, unknown>> };
        for (const n of answer.newScopes ?? []) named.set(text(n.workspace), n);
        // The batch numbers its candidates from 0; map them back to the day's.
        for (const raw of answer.decisions ?? []) raws.push({ ...raw, candidate: [raw.candidate].flat().map(Number)
          .filter((i) => Number.isInteger(i) && batch[i] !== undefined).map((i) => batch[i]!) });
      } catch (error) { for (const index of batch) failures.set(index, error instanceof Error ? error.message : String(error)); }
    }
    const decisions: MemoryDecision[] = [];
    for (const raw of raws) {
      const indexes = (raw.candidate as number[]).filter((i) => candidates[i]);
      const first = candidates[indexes[0]!];
      if (!first) continue;
      const session = bySession.get(first.session)!;
      const action = raw.action === "project" || raw.action === "global" ? raw.action : "skip";
      const decision: MemoryDecision = { candidates: indexes, action, scope: "", topic: text(raw.topic), kind: text(raw.kind) || first.kind,
        value: text(raw.value) || first.value, pin: raw.pin === true, reason: text(raw.reason), conflict: text(raw.conflict),
        derivedFrom: [...new Set(indexes.map((i) => `session:${candidates[i]!.session}`))] };
      if (action === "global") decision.scope = "_global";
      else if (action === "project" && session.scope) decision.scope = session.scope.id;
      else if (action === "project") {
        const name = named.get(session.path), hint = text(name?.id);
        const repository = (db.prepare("SELECT project_identity FROM sessions WHERE id=?").get(session.id) as { project_identity: string | null } | undefined)?.project_identity;
        if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(hint)) {
          decision.scope = hint;
          decision.create = { machine_id: session.machineId, cwd: session.path, ...(repository ? { repository } : {}), scope_hint: hint, title: text(name?.title) || hint };
        } else { decision.action = "human"; decision.reason = `没有作用域，也没起好名字：${decision.reason}`; }
      }
      if (decision.action !== "skip" && (decision.conflict || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(decision.topic))) decision.action = "human";
      decisions.push(decision);
    }
    // A candidate the model left out is not dropped quietly.
    const decided = new Set(decisions.flatMap((d) => d.candidates));
    candidates.forEach((c, i) => {
      if (!decided.has(i)) decisions.push({ candidates: [i], action: "human", scope: bySession.get(c.session)?.scope?.id ?? "", topic: "", kind: c.kind,
        value: c.value, pin: false, reason: failures.has(i) ? `归档失败：${failures.get(i)}` : "归档模型没有给出决定", conflict: "", derivedFrom: [`session:${c.session}`] });
    });
    if (!failures.size) db.prepare(`INSERT INTO journal_archives (date,candidates_hash,decisions,created_at) VALUES (?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET candidates_hash=excluded.candidates_hash, decisions=excluded.decisions, created_at=excluded.created_at`)
      .run(date, hash, JSON.stringify(decisions), this.now());
    return decisions;
  }

  /** Automations create their table; without them there is nothing to count. */
  private hasRuns(): boolean {
    return Boolean(this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_runs'").get());
  }

  private automationDay(from: number, to: number): AutomationDay {
    if (!this.hasRuns()) return { tasks: 0, runs: 0, ok: 0, failed: 0, silent: 0, missed: 0, failures: [] };
    const tasks = new Map((this.options.automations?.() ?? []).map((task) => [task.id, task]));
    const runs = this.options.db.prepare("SELECT automation_id, trigger_at, status, error FROM automation_runs WHERE trigger_at>=? AND trigger_at<? ORDER BY trigger_at")
      .all(from, to) as Array<{ automation_id: string; trigger_at: number; status: string; error: string | null }>;
    const count = (status: string) => runs.filter((run) => run.status === status).length;
    const failures: AutomationDay["failures"] = runs.filter((run) => run.status === "failed" || run.status === "missed").map((run) => ({
      id: run.automation_id, title: tasks.get(run.automation_id)?.title ?? run.automation_id, status: run.status as "failed" | "missed",
      at: Number(run.trigger_at), error: String(run.error ?? "").slice(0, 160), delivered: Boolean(tasks.get(run.automation_id)?.deliver.length) }));
    // Due by its schedule but no run at all, not even a `missed` one: the Control Plane was down then.
    const seen = new Set(runs.map((run) => `${run.automation_id}\n${Math.round(Number(run.trigger_at) / 60_000)}`));
    for (const task of tasks.values()) {
      if (!task.schedule?.cron || task.paused || !task.enabled) continue;
      let cron; try { cron = parseCron(task.schedule.cron); } catch { continue; }
      for (let at = nextCron(cron, from - 60_000, task.schedule.tz ?? this.options.tz); at !== undefined && at < to && at < this.now() - 600_000;
        at = nextCron(cron, at, task.schedule.tz ?? this.options.tz)) {
        if (seen.has(`${task.id}\n${Math.round(at / 60_000)}`)) continue;
        failures.push({ id: task.id, title: task.title, status: "missed", at, error: "到点没有运行记录", delivered: Boolean(task.deliver.length) });
      }
    }
    return { tasks: new Set(runs.map((run) => run.automation_id)).size, runs: runs.length, ok: count("ok"), failed: count("failed"), silent: count("silent"),
      missed: failures.filter((f) => f.status === "missed").length, failures };
  }

  /** This day's items replace its open ones; then any open item whose session moved on since closes by itself. */
  private ledger(date: string, to: number, sessions: JournalSession[], decisions: MemoryDecision[], automations: AutomationDay, candidates: MemoryCandidate[]): JournalItem[] {
    const db = this.options.db, now = this.now(), md = date.slice(5).replace("-", "");
    const wanted: Array<Omit<JournalItem, "openedAt" | "closedAt" | "closedBy" | "date">> = [];
    for (const s of sessions) {
      const base = `jn-${shortId(s.id)}-${md}`, scope = s.scope?.id ?? null;
      const add = (kind: ItemKind, title: string) => wanted.push({ id: `${base}-${kind}`, kind, title, scope, sessionId: s.id, automationId: null });
      if (s.status === "interrupted") add("interrupted", s.next || s.title);
      else if (s.status === "failed") add("failed", s.next || s.title);
      else if (s.next) add("next", s.next);
      if (s.waitingOnHuman) add("human", s.waitingOnHuman);
      else if (s.pending) add("human", `${s.pending} 个审批/提问没有处理`);
    }
    for (const d of decisions) if (d.action === "human") {
      const id = `jn-m-${createHash("sha256").update(`${date}\n${d.value}`).digest("hex").slice(0, 10)}`;
      const session = candidates[d.candidates[0]!]?.session ?? null;
      wanted.push({ id, kind: "memory", title: `记忆待定：${d.value}${d.conflict ? `（冲突：${d.conflict}）` : d.reason ? `（${d.reason}）` : ""}`,
        scope: d.scope || null, sessionId: session, automationId: null });
    }
    for (const f of automations.failures) if (!f.delivered && !wanted.some((w) => w.id === `jn-a-${f.id}-${md}`))
      wanted.push({ id: `jn-a-${f.id}-${md}`, kind: "automation", title: `${f.title}${f.status === "missed" ? "该跑没跑" : "失败"}：${f.error}`,
        scope: null, sessionId: null, automationId: f.id });
    const ids = new Set(wanted.map((w) => w.id));
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of db.prepare("SELECT id FROM journal_items WHERE date=? AND closed_at IS NULL").all(date) as Array<{ id: string }>)
        if (!ids.has(row.id)) db.prepare("DELETE FROM journal_items WHERE id=?").run(row.id);
      for (const w of wanted) db.prepare(`INSERT INTO journal_items (id,date,kind,title,scope,session_id,automation_id,window_end,opened_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, scope=excluded.scope WHERE journal_items.closed_at IS NULL`)
        .run(w.id, date, w.kind, w.title, w.scope, w.sessionId, w.automationId, to, now);
      const moved = db.prepare(`SELECT i.id FROM journal_items i WHERE i.closed_at IS NULL AND i.kind<>'memory' AND (
          (i.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM events e WHERE e.session_id=i.session_id AND e.type='turn.started' AND e.created_at>=i.window_end))
          ${this.hasRuns() ? "OR (i.automation_id IS NOT NULL AND EXISTS (SELECT 1 FROM automation_runs r WHERE r.automation_id=i.automation_id AND r.trigger_at>=i.window_end AND r.status IN ('ok','silent')))" : ""})`)
        .all() as Array<{ id: string }>;
      for (const row of moved) db.prepare("UPDATE journal_items SET closed_at=?, closed_by='auto' WHERE id=?").run(now, row.id);
      db.exec("COMMIT");
      return moved.map((row) => itemWire(db.prepare("SELECT * FROM journal_items WHERE id=?").get(row.id) as Record<string, unknown>));
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

/**
 * The state at the end of the day, from the last turn event before it. A turn the Bridge lost
 * (a reason on the event, or one still open that the session no longer runs) is interrupted; one a
 * person stopped is not.
 */
export function programStatus(turns: Turn[], to: number, activeTurnId: string | null): { status: JournalStatus; interruptions: string } {
  const inside = turns.filter((t) => t.at < to), last = inside.at(-1);
  const lost = (t: Turn) => t.type === "turn.interrupted" && Boolean(t.reason);
  let status: JournalStatus = "done";
  if (last?.type === "turn.started") {
    const ended = turns.find((t) => t.turn === last.turn && t.type !== "turn.started");
    // Still running at midnight: it ended later, or runs now. Lost later, or gone without an end, it was cut off.
    status = ended ? lost(ended) ? "interrupted" : "in_progress" : activeTurnId === last.turn ? "in_progress" : "interrupted";
  } else if (last && lost(last)) status = "interrupted";
  else if (last?.type === "turn.failed") status = "failed";
  const losses = inside.filter(lost).length;
  const interruptions = status === "interrupted" ? `${clock(last!.at)} turn 中断，当天之后没有新的 turn${turns.some((t) => t.at >= to && t.type === "turn.started") ? "（次日有续）" : ""}`
    : losses ? `${losses} 次中断，之后都有新的 turn 接着做` : "";
  return { status, interruptions };
}

/** The human's every message and the last turns stay; the agent's replies in between go first when it is too long. */
export function transcript(messages: Message[], cap = 40_000): string {
  const lines = messages.map((m) => `[${clock(m.at)}] ${m.role === "user" ? "人" : "agent"}：${m.text.length > 3000 ? `${m.text.slice(0, 1500)}\n…（略）…\n${m.text.slice(-1200)}` : m.text}`);
  for (let i = 3; i < messages.length - 6 && lines.join("\n\n").length > cap; i++) if (messages[i]!.role !== "user") lines[i] = "[…]";
  return lines.join("\n\n");
}

/** Midnight of `date` in `tz`, as epoch ms. */
export function dayStart(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let at = guess - offset(guess, tz);
  at = guess - offset(at, tz);
  return at;
}

export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function offset(ms: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(ms).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(ms / 1000) * 1000;
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const shortId = (id: string) => id.replace(/^(claude|pi|codex)-/, "").slice(0, 8);

function itemWire(row: Record<string, unknown>): JournalItem {
  return { id: String(row.id), date: String(row.date), kind: row.kind as ItemKind, title: String(row.title), scope: row.scope == null ? null : String(row.scope),
    sessionId: row.session_id == null ? null : String(row.session_id), automationId: row.automation_id == null ? null : String(row.automation_id),
    openedAt: Number(row.opened_at), closedAt: row.closed_at == null ? null : Number(row.closed_at), closedBy: row.closed_by == null ? null : row.closed_by as "auto" | "human" };
}

function summarySystem(day: string): string {
  return `你在整理用户的 agent 在 ${day} 这天的一个会话里做了什么，结果会写进他的工作日志。只输出一个 JSON 对象，不要别的文字：
{"title":"≤16字的会话主题","done":["做成了什么，一句一件"],"next":"agent 自己接下来要做、但还没做的事；没有就空字符串","waitingOnHuman":"没有用户回应 agent 就没法往下做的决定或动作；没有就空字符串","memory":[{"kind":"rule|preference|decision|fact|lesson","value":"一句话","evidence":"HH:MM「人的原话」"}]}
done：
- 最多 3 条，每条 40 字以内，只写交付的结果（上线了什么、查明了什么、定了什么）。几件小事合成一句。
- 只留读者需要的一个关键数字或版本号；不写 PID、提交哈希、IP、MAC、文件路径、会话 id、测试条数这类细节。
- 不写过程和中间动作：不写「澄清了意图」「回答了问题」「保存了文件」「收集了 N 个来源」，不写工具输出。
next / waitingOnHuman：
- 状态是 interrupted/failed 时，next 写被打断时正在做的事。
- waitingOnHuman 从严：只有 agent 明确停下来等用户拍板、提供信息或做一个它做不了的动作（例如在设备上按确认），才写。agent 结尾的客套（「需要的话告诉我」「可以试试看」「请验收」）不算，写空。
memory：
- 只认标为「人」的消息里用户本人说的话；自动任务的提示词、系统推送、转发内容、脚本输出不算。
- 只提「以后干活怎么做」的规则和约束：用户纠正了 agent 的做法，而以后的 agent 不知道还会犯同样的错。
- 不要提「要做什么」：功能需求、产品设计、架构选择、界面怎么摆、配色样式文案。做完了就在代码和文档里，不是记忆。
- 也不要提：一次性的具体值；只对这一次有效的指令；agent 自己总结的经验；故障排查里的一次性判断。
- value 写明适用范围：只对这个项目/这个工具成立的，就写成「在 X 里……」，不要写成一类事情的通用规则（例如采访工具用本地 ASR，写「采访工具的 ASR 用本地 Qwen3-ASR」，不写「ASR 优先用本地」）。只有他明确说是一类事情的通用做法（「我们所有 App 都这样」），才写成通用形式。
- 用户说明的、会持续一段时间的自身处境（收支、资产用途、家里设备的状况），以后回答要用到的，可以记为 fact。
- 大部分会话没有记忆候选，宁缺毋滥。`;
}

/** Candidates per archive call. */
const ARCHIVE_BATCH = 8;

const ARCHIVE_SYSTEM = `你是中央记忆的归档员。给你昨天对话里提出的记忆候选，每个都附上它所属项目的作用域和那里已有的记忆，以及全局作用域 _global 已有的记忆。决定每个候选怎么处理。只输出 JSON：
{"decisions":[{"candidate":序号或序号数组,"action":"project|global|skip","topic":"小写英文连字符 slug","kind":"rule|preference|decision|fact|lesson","value":"一句话，写成以后的 agent 读了就知道怎么做","pin":true或false,"conflict":"与 _global 或项目已有记忆相反时写明冲突的那条，否则空","reason":"一句话"}],
 "newScopes":[{"workspace":"工作目录原样","id":"小写英文连字符","title":"简短中文标题"}]}
规则：
- 默认写进项目作用域（action=project）。项目作用域不存在时也选 project，并在 newScopes 里给这个工作目录起作用域：目录名能看出是什么就按目录起，起不好（中文、日期、单个字母）就按对话内容起。id 用英文单词，不用拼音。同一工作目录只起一个；只为最终 action=project 的候选起。title 写这个目录整体是什么，不要写成当天聊的那件事。
- 和 _global 或项目已有的记忆说法相反的，照样给出决定，但在 conflict 写明是哪条，交给人审。
- global 很少用：只有用户明确说这是所有项目/所有 App 的通用做法，才选 global；写全局会再经过自动审核。只是「听起来通用」的，仍写项目作用域。
- 同一个主题的几个候选合成一条（candidate 写序号数组）。目标作用域已有同义记忆就 skip。
- 只记「以后干活怎么做」的规则和约束（纠正过的做法，不记下来以后还会犯）。
- 例外：用户说明的、会持续一段时间的自身处境（收支、资产用途、家里设备的状况），以后在这个作用域回答问题都要用到，记为 fact。
- skip「要做什么」：功能需求、产品设计、架构选择、界面摆放、模块怎么拆分或解耦、放在哪个仓库/进程、复用哪个 token 或账号、配色样式文案——这些做完就在代码和文档里。写成「在 X 里……」也照样 skip。判断标准：下一个 agent 换个任务时还会不会犯同样的错；只是这件事的设计，就 skip。
- skip：一次性的具体值、只对这一次有效的指令、agent 自己的总结、拿不准的。
- pin 只给几乎每次在该作用域干活都需要的规则和偏好。`;
