import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import pino from "pino";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decodeEventBody, type AgentControlStore, type NoticeLevel } from "@agent-bridge/database";
import { parseWorkerId, type AgentType, type ControlToBridgeMessage } from "@agent-bridge/protocol";
import type { BridgeRegistry } from "./bridge-registry.js";
import { nextCron, parseCron, type Cron } from "./cron.js";
import { parseNoticeTarget, type NoticeTarget } from "./notices.js";
import type { SecretStore } from "./secrets.js";

const log = pino({ name: "automations" });
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_OUTPUT = 64 * 1024;
const RELOAD_MS = 15_000;
const ON_TIME_MS = 10 * 60_000;
const CATCH_UP_MS = 60 * 60_000;
const HOOK_DEDUPE_MS = 10 * 60_000;
const PROPOSAL_TTL_MS = 7 * 86_400_000;
const AGENT_TYPES: Record<string, AgentType> = { pi: "pi", codex: "codex-cli", claude: "claude-code", grok: "grok" };

/** One task as written in `<dir>/<scope>/<id>/automation.yaml` (docs/automations-design.zh.md). */
export interface AutomationDefinition {
  title: string;
  trigger: { schedule?: { cron?: string; everyMinutes?: number; tz?: string; catchUp?: "once" | "skip" };
    webhook?: { secretRef?: string; template?: string } };
  script?: { path: string; cwd?: string; timeoutSec?: number; envFile?: string };
  agent?: { prompt: string; agent?: string; model?: string; target?: string; timeoutMin?: number };
  /** Notify only: the message, with `{a.b}` placeholders filled from the webhook body or the script's JSON. */
  template?: string;
  deliver?: string[];
  level?: NoticeLevel;
  enabled?: boolean;
}

export interface Automation { id: string; scope: string; dir: string; definition?: AutomationDefinition; error?: string;
  cron?: Cron; hash: string }

export interface AutomationRun { id: string; automationId: string; trigger: string; triggerAt: number; startedAt: number | null;
  finishedAt: number | null; status: "running" | "ok" | "silent" | "failed" | "skipped" | "missed"; sessionId: string | null;
  output: string | null; error: string | null }

export interface AutomationProposal { id: string; action: "create" | "update" | "delete"; automationId: string; scope: string;
  definition: AutomationDefinition | null; previous: AutomationDefinition | null; reason: string | null; proposedBy: string;
  status: "pending" | "applied" | "denied" | "expired" | "failed"; error: string | null; createdAt: number; decidedAt: number | null;
  decidedBy: string | null }

export interface AutomationOptions {
  /** `<dir>/<scope>/<id>/automation.yaml`; usually the private skill repository's `automations/`. */
  dir: string;
  /** Absolute directories (besides a task's own) its script may live in. */
  scriptRoots: string[];
  /** KEY=value file holding webhook secrets, named by `secretRef`. */
  secretsFile?: string;
  defaultAgent: string;
  defaultModel?: string;
  /** Where failures and proposals are announced; `app:operator` by default. */
  operatorTarget: NoticeTarget;
  /** flock path shared with the skill library, which lives in the same repository. */
  lockPath?: string;
  push: boolean;
  /** OpenBao: a webhook's `secretRef` is looked up at `shared/webhooks` before the secrets file. */
  secrets?: SecretStore;
}

export interface AutomationDeps {
  store: AgentControlStore;
  registry: BridgeRegistry;
  dispatch(action: { actionId: string; machineId: string }, message: ControlToBridgeMessage): void;
  /** A scope's default place to run a new session, as chat rooms pick theirs. */
  scopeTarget?(scope: string, agent: string): { workerId: string; workspace: string } | null | undefined;
  validScope?(scope: string): boolean;
  now?: () => number;
  /** How often an agent run checks its session (2 s). */
  pollMs?: number;
}

export class AutomationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const silent = (text: string): boolean => !text.trim() || text.trim().startsWith("[SILENT]");
const clip = (text: string, limit = MAX_OUTPUT): string => text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** `{a.b}` from `data`; a missing field renders empty, an object as JSON. */
export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z_][\w.]*)\}/g, (_, path: string) => {
    let value: unknown = data;
    for (const part of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

export function validateDefinition(raw: unknown): AutomationDefinition {
  const fail = (message: string): never => { throw new Error(message); };
  if (!raw || typeof raw !== "object") fail("definition must be a mapping");
  const value = raw as Record<string, any>;
  if (typeof value.title !== "string" || !value.title.trim()) fail("title is required");
  const trigger = value.trigger ?? {};
  const schedule = trigger.schedule, webhook = trigger.webhook;
  if (!schedule === !webhook) fail("trigger needs exactly one of schedule or webhook");
  if (schedule) {
    if (!schedule.cron === !schedule.everyMinutes) fail("schedule needs exactly one of cron or everyMinutes");
    if (schedule.cron) parseCron(String(schedule.cron));
    if (schedule.everyMinutes !== undefined && !(Number.isInteger(schedule.everyMinutes) && schedule.everyMinutes >= 1)) fail("everyMinutes must be a positive integer");
    if (schedule.tz) try { new Intl.DateTimeFormat("en-US", { timeZone: schedule.tz }); } catch { fail(`unknown time zone ${schedule.tz}`); }
    if (schedule.catchUp && !["once", "skip"].includes(schedule.catchUp)) fail("catchUp must be once or skip");
  }
  if (webhook?.secretRef !== undefined && (typeof webhook.secretRef !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(webhook.secretRef))) fail("webhook.secretRef must name a secret");
  if (value.script && (typeof value.script.path !== "string" || !value.script.path)) fail("script.path is required");
  if (value.agent && (typeof value.agent.prompt !== "string" || !value.agent.prompt.trim())) fail("agent.prompt is required");
  if (value.agent?.agent && !AGENT_TYPES[value.agent.agent]) fail(`agent must be one of ${Object.keys(AGENT_TYPES).join(", ")}`);
  if (value.agent?.target && !/^[a-z]+@[^:]+:\/.*/.test(value.agent.target)) fail("agent.target must be <agent>@<machine>:/path");
  if (!value.script && !value.agent && !value.template && !webhook?.template) fail("a task needs a script, an agent or a template");
  if (value.deliver !== undefined && (!Array.isArray(value.deliver) || value.deliver.some((item: unknown) => typeof item !== "string"
    || (item !== "app" && !parseNoticeTarget(item))))) fail("deliver must list targets like app or matrix:!room:server");
  if (value.level && !["silent", "notice", "alert"].includes(value.level)) fail("level must be silent, notice or alert");
  return value as AutomationDefinition;
}

/**
 * Scheduled and webhook-triggered work (docs/automations-design.zh.md): run a script, an agent
 * session or both, and deliver the result as notices. Definitions live in Git; this keeps only
 * the schedule state, run history and proposals, in the Control Plane's SQLite.
 */
export class Automations {
  private tasks = new Map<string, Automation>();
  private readonly running = new Set<string>();
  private readonly hookSeen = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stamp = "";
  private readonly now: () => number;

  constructor(private readonly options: AutomationOptions, private readonly deps: AutomationDeps) {
    this.now = deps.now ?? Date.now;
    deps.store.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_state (id TEXT PRIMARY KEY, definition_hash TEXT NOT NULL,
        next_at INTEGER, paused INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, trigger TEXT NOT NULL,
        trigger_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, session_id TEXT,
        output TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS automation_runs_task ON automation_runs(automation_id, trigger_at);
      CREATE TABLE IF NOT EXISTS automation_proposals (id TEXT PRIMARY KEY, action TEXT NOT NULL, automation_id TEXT NOT NULL,
        scope TEXT NOT NULL, definition TEXT, previous TEXT, reason TEXT, proposed_by TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT);
    `);
    // A run cut off by a restart never finishes.
    deps.store.db.prepare("UPDATE automation_runs SET status='failed',error='Control Plane 重启，运行中断',finished_at=? WHERE status='running'")
      .run(this.now());
  }

  start(): void {
    this.reload();
    this.timer = setInterval(() => { try { this.reload(); this.tick(); } catch (error) { log.error({ error }, "Automation tick failed"); } }, RELOAD_MS);
    this.timer.unref();
    this.tick();
  }

  stop(): void { clearInterval(this.timer); }

  // ---- definitions ----------------------------------------------------------

  /** Re-read the definitions when a file changed. */
  reload(force = false): void {
    const files: Array<{ scope: string; id: string; path: string; mtime: number }> = [];
    if (existsSync(this.options.dir)) for (const scope of readdirSync(this.options.dir).sort()) {
      const scopeDir = join(this.options.dir, scope);
      if (!SLUG.test(scope) && !/^_[a-z0-9-]+$/.test(scope) || !statSync(scopeDir).isDirectory()) continue;
      for (const id of readdirSync(scopeDir).sort()) {
        const path = join(scopeDir, id, "automation.yaml");
        if (SLUG.test(id) && existsSync(path)) files.push({ scope, id, path, mtime: statSync(path).mtimeMs });
      }
    }
    const stamp = JSON.stringify(files);
    if (!force && stamp === this.stamp) return;
    this.stamp = stamp;
    const tasks = new Map<string, Automation>();
    for (const file of files) {
      const text = readFileSync(file.path, "utf8");
      const task: Automation = { id: file.id, scope: file.scope, dir: dirname(file.path), hash: hash(text) };
      if (tasks.has(file.id)) task.error = `id ${file.id} is used by more than one scope`;
      else try {
        task.definition = validateDefinition(parseYaml(text));
        const schedule = task.definition.trigger.schedule;
        if (schedule?.cron) task.cron = parseCron(schedule.cron);
        if (task.definition.script) this.scriptPath(task);
      } catch (error) { task.error = error instanceof Error ? error.message : String(error); }
      tasks.set(file.id, task);
    }
    this.tasks = tasks;
    const now = this.now();
    for (const task of tasks.values()) {
      const state = this.state(task.id);
      if (state?.definition_hash === task.hash) continue;
      this.deps.store.db.prepare(`INSERT INTO automation_state(id,definition_hash,next_at,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET definition_hash=excluded.definition_hash,next_at=excluded.next_at,updated_at=excluded.updated_at`)
        .run(task.id, task.hash, this.nextAfter(task, now) ?? null, now);
    }
  }

  private state(id: string): { definition_hash: string; next_at: number | null; paused: number } | undefined {
    return this.deps.store.db.prepare("SELECT definition_hash,next_at,paused FROM automation_state WHERE id=?").get(id) as never;
  }

  private nextAfter(task: Automation, after: number): number | undefined {
    const schedule = task.definition?.trigger.schedule;
    if (!schedule || task.error) return undefined;
    if (task.cron) return nextCron(task.cron, after, schedule.tz ?? "Asia/Shanghai");
    return after + schedule.everyMinutes! * 60_000;
  }

  list(): Array<Record<string, unknown>> {
    return [...this.tasks.values()].map((task) => this.summary(task));
  }

  get(id: string): Record<string, unknown> | undefined {
    const task = this.tasks.get(id);
    return task && { ...this.summary(task), definition: task.definition ?? null, runs: this.runs(id, 20) };
  }

  private summary(task: Automation): Record<string, unknown> {
    const state = this.state(task.id), definition = task.definition;
    const last = this.deps.store.db.prepare("SELECT * FROM automation_runs WHERE automation_id=? ORDER BY trigger_at DESC LIMIT 1").get(task.id);
    return { id: task.id, scope: task.scope, title: definition?.title ?? task.id, error: task.error ?? null,
      trigger: definition?.trigger.schedule ? "schedule" : definition?.trigger.webhook ? "webhook" : null,
      schedule: definition?.trigger.schedule ?? null, kind: definition ? kindOf(definition) : null,
      enabled: definition ? definition.enabled !== false : false, paused: Boolean(state?.paused), nextAt: state?.next_at ?? null,
      deliver: definition ? this.targets(definition).map(targetText) : [], lastRun: last ? runWire(last as Record<string, unknown>) : null };
  }

  runs(id: string, limit = 50): AutomationRun[] {
    return (this.deps.store.db.prepare("SELECT * FROM automation_runs WHERE automation_id=? ORDER BY trigger_at DESC LIMIT ?")
      .all(id, limit) as Array<Record<string, unknown>>).map(runWire);
  }

  setPaused(id: string, paused: boolean): Record<string, unknown> {
    const task = this.require(id);
    this.deps.store.db.prepare("UPDATE automation_state SET paused=?,next_at=?,updated_at=? WHERE id=?")
      .run(Number(paused), paused ? this.state(id)?.next_at ?? null : this.nextAfter(task, this.now()) ?? null, this.now(), id);
    return this.summary(task);
  }

  private require(id: string): Automation {
    const task = this.tasks.get(id);
    if (!task) throw new AutomationError(404, "automation_not_found", "automation not found");
    return task;
  }

  // ---- triggers -------------------------------------------------------------

  /** Fire every schedule that is due: on time, or once if it missed its time by less than an hour. */
  tick(): void {
    const now = this.now();
    for (const task of this.tasks.values()) {
      const state = this.state(task.id), definition = task.definition;
      if (!definition?.trigger.schedule || task.error || !state?.next_at || state.next_at > now) continue;
      const due = state.next_at;
      this.deps.store.db.prepare("UPDATE automation_state SET next_at=?,updated_at=? WHERE id=?")
        .run(this.nextAfter(task, now) ?? null, now, task.id);
      if (state.paused || definition.enabled === false) continue;
      const late = now - due, catchUp = definition.trigger.schedule.catchUp ?? "once";
      if (late > ON_TIME_MS && (catchUp === "skip" || late > CATCH_UP_MS)) { this.record(task.id, "schedule", due, "missed", `晚了 ${Math.round(late / 60_000)} 分钟，未补跑`); continue; }
      void this.fire(task, "schedule", due, {});
    }
  }

  /** A manual run, whatever the trigger; returns the run id. */
  runNow(id: string, payload: Record<string, unknown> = {}): string {
    const task = this.require(id);
    if (task.error || !task.definition) throw new AutomationError(409, "automation_invalid", task.error ?? "invalid");
    return this.fire(task, "manual", this.now(), payload);
  }

  /**
   * POST /hooks/<id>: verify the signature (GitHub `X-Hub-Signature-256`, GitLab `X-Gitlab-Token`,
   * Hermes `X-Webhook-Signature[-V2]`), drop a redelivery, and start the run.
   */
  async hook(id: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
    const task = this.tasks.get(id), webhook = task?.definition?.trigger.webhook;
    if (!task || !webhook || task.error) return { status: 404, body: { error: "not_found" } };
    // A hook without secretRef is open: it can only start the run its definition describes.
    if (webhook.secretRef) {
      const secret = await this.options.secrets?.value(webhook.secretRef, ["shared/webhooks"]).catch(() => undefined) ?? this.secret(webhook.secretRef);
      if (!secret || !verifySignature(headers, body, secret, this.now())) return { status: 401, body: { error: "invalid_signature" } };
    }
    if (task.definition!.enabled === false || this.state(id)?.paused) return { status: 202, body: { skipped: "paused" } };
    let payload: Record<string, unknown> = {};
    if (body.length) {
      try { const parsed = JSON.parse(body.toString("utf8")); payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed }; }
      catch { payload = { text: body.toString("utf8") }; }
    }
    const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };
    const delivery = header("x-github-delivery") ?? header("webhook-id") ?? header("x-request-id") ?? header("idempotency-key") ?? hash(body.toString("binary"));
    const seenKey = `${id}\n${delivery}`, now = this.now();
    for (const [key, at] of this.hookSeen) if (now - at > HOOK_DEDUPE_MS) this.hookSeen.delete(key);
    if (this.hookSeen.has(seenKey)) return { status: 202, body: { duplicate: true } };
    this.hookSeen.set(seenKey, now);
    return { status: 202, body: { runId: this.fire(task, "webhook", now, payload) } };
  }

  private secret(name: string): string | undefined {
    const file = this.options.secretsFile;
    if (!file || !existsSync(file)) return undefined;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match?.[1] === name) return match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
    return undefined;
  }

  // ---- running --------------------------------------------------------------

  private record(id: string, trigger: string, at: number, status: AutomationRun["status"], error?: string): string {
    const runId = randomUUID();
    this.deps.store.db.prepare(`INSERT INTO automation_runs(id,automation_id,trigger,trigger_at,started_at,finished_at,status,error)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, id, trigger, at, null, this.now(), status, error ?? null);
    return runId;
  }

  private fire(task: Automation, trigger: string, at: number, payload: Record<string, unknown>): string {
    if (this.running.has(task.id)) return this.record(task.id, trigger, at, "skipped", "上一次运行尚未结束");
    const runId = randomUUID();
    this.deps.store.db.prepare(`INSERT INTO automation_runs(id,automation_id,trigger,trigger_at,started_at,status) VALUES(?,?,?,?,?,'running')`)
      .run(runId, task.id, trigger, at, this.now());
    this.running.add(task.id);
    void this.execute(task, runId, payload)
      .then((result) => this.finish(task, runId, result))
      .catch((error) => this.finish(task, runId, { status: "failed", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => this.running.delete(task.id));
    return runId;
  }

  private async execute(task: Automation, runId: string, payload: Record<string, unknown>):
    Promise<{ status: "ok" | "silent" | "failed"; output?: string; error?: string; sessionId?: string; text?: string }> {
    const definition = task.definition!;
    let output = "", data: Record<string, unknown> = { ...payload }, json = false;
    if (definition.script) {
      const result = await this.runScript(task, runId, payload);
      output = result.stdout;
      if (result.code !== 0) return { status: "failed", output, error: `脚本退出码 ${result.code}${result.stderr ? `：${result.stderr.slice(-800)}` : ""}` };
      try { const parsed = JSON.parse(output); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { data = { ...data, ...parsed }; json = true; } } catch {}
      if (!definition.agent && !definition.template && !definition.trigger.webhook?.template) return { status: silent(output) ? "silent" : "ok", output, text: output };
    }
    const template = definition.template ?? definition.trigger.webhook?.template;
    if (!definition.agent) {
      const text = template ? renderTemplate(template, data) : JSON.stringify(payload, null, 2).slice(0, 4000);
      return { status: (definition.script && silent(output)) || silent(text) ? "silent" : "ok", output: output || undefined, text };
    }
    if (definition.script && silent(output)) return { status: "silent", output };
    // A script's JSON fills the prompt's placeholders; plain output goes on top, as Hermes injected it.
    const prompt = [definition.script && !json ? `[脚本输出]\n${output.trim()}\n` : "", renderTemplate(definition.agent.prompt, data)].filter(Boolean).join("\n");
    const run = await this.runAgent(task, runId, prompt);
    return { ...run, output: run.text };
  }

  private scriptPath(task: Automation): string {
    const script = task.definition!.script!;
    const path = realpathSync(isAbsolute(script.path) ? script.path : resolve(task.dir, script.path));
    const inside = (root: string) => { try { const rel = relative(realpathSync(root), path); return rel && !rel.startsWith("..") && !isAbsolute(rel); } catch { return false; } };
    if (!inside(task.dir) && !this.options.scriptRoots.some(inside)) throw new Error(`script ${script.path} is outside the task and AUTOMATION_SCRIPT_ROOTS`);
    return path;
  }

  private runScript(task: Automation, runId: string, payload: Record<string, unknown>): Promise<{ code: number; stdout: string; stderr: string }> {
    const script = task.definition!.script!, path = this.scriptPath(task);
    const interpreter = { ".py": "python3", ".sh": "bash" }[extname(path)];
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? homedir(),
      LANG: process.env.LANG ?? "C.UTF-8", TZ: task.definition!.trigger.schedule?.tz ?? "Asia/Shanghai", AUTOMATION_ID: task.id, AUTOMATION_RUN_ID: runId };
    if (script.envFile) for (const line of readFileSync(script.envFile, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
    return new Promise((done) => {
      const child = spawn(interpreter ?? path, interpreter ? [path] : [], { cwd: script.cwd ?? task.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT * 2) stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      const timeout = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5_000).unref(); }, (script.timeoutSec ?? 600) * 1_000);
      timeout.unref();
      child.on("error", (error) => { clearTimeout(timeout); done({ code: -1, stdout, stderr: error.message }); });
      child.on("close", (code, signal) => { clearTimeout(timeout); done({ code: code ?? (signal ? 128 : -1), stdout: clip(stdout), stderr: signal ? `${stderr}\n(${signal})` : stderr }); });
      // A script that exits without reading its input closes the pipe first; that is not an error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(payload));
    });
  }

  private async runAgent(task: Automation, runId: string, prompt: string): Promise<{ status: "ok" | "silent" | "failed"; error?: string; sessionId?: string; text?: string }> {
    const agent = task.definition!.agent!, agentName = agent.agent ?? this.options.defaultAgent;
    let target: { workerId: string; workspace: string } | null | undefined;
    if (agent.target) { const at = agent.target.indexOf(":"); target = { workerId: agent.target.slice(0, at), workspace: agent.target.slice(at + 1) }; }
    else target = this.deps.scopeTarget?.(task.scope, agentName);
    if (!target) return { status: "failed", error: `作用域 ${task.scope} 没有可用的工作目录；在任务里写 agent.target` };
    const parsed = parseWorkerId(target.workerId), agentType = parsed && AGENT_TYPES[parsed.prefix];
    if (!parsed || !agentType) return { status: "failed", error: `无效的 worker ${target.workerId}` };
    if (!this.deps.registry.get(parsed.machineId)) return { status: "failed", error: `${parsed.machineId} 不在线` };
    const memoryScope = this.deps.validScope?.(task.scope) ? task.scope : undefined, model = agent.model ?? this.options.defaultModel;
    const body = { workerId: target.workerId, workspace: target.workspace, input: prompt, model, memoryScope };
    const { action } = this.deps.store.createAction({ principal: "system:automations", key: runId, method: "POST", path: "/api/v1/sessions",
      body, kind: "create_session", machineId: parsed.machineId });
    this.deps.dispatch(action, { type: "action.create_session", actionId: action.actionId, agentType, projectPath: target.workspace,
      input: prompt, ...(model ? { model } : {}), ...(memoryScope ? { memoryScope } : {}) } as ControlToBridgeMessage);
    const deadline = this.now() + (agent.timeoutMin ?? 30) * 60_000;
    let sessionId: string | undefined;
    while (this.now() < deadline) {
      await new Promise((wake) => setTimeout(wake, this.deps.pollMs ?? 2_000));
      if (!sessionId) {
        const current = this.deps.store.action(action.actionId);
        if (current?.status === "failed") return { status: "failed", error: `会话没有建成：${current.error?.message ?? current.error?.code}` };
        if (current?.status !== "succeeded" || !current.sessionId) continue;
        sessionId = current.sessionId;
        this.deps.store.db.prepare("UPDATE automation_runs SET session_id=? WHERE id=?").run(sessionId, runId);
      }
      const end = this.deps.store.db.prepare(`SELECT type,body FROM events WHERE session_id=? AND type IN ('turn.completed','turn.failed','turn.interrupted')
        ORDER BY id DESC LIMIT 1`).get(sessionId) as { type: string; body: unknown } | undefined;
      if (!end) continue;
      const message = this.deps.store.db.prepare(`SELECT body FROM events WHERE session_id=? AND type='message.completed' ORDER BY id DESC LIMIT 20`)
        .all(sessionId) as Array<{ body: unknown }>;
      const text = message.map((row) => decodeEventBody(row.body)).find((payload) => payload.role === "assistant" && typeof payload.text === "string")?.text as string | undefined ?? "";
      if (end.type !== "turn.completed") {
        const payload = decodeEventBody(end.body), error = payload.error as { message?: string } | string | undefined;
        return { status: "failed", sessionId, text, error: `agent ${end.type === "turn.failed" ? "失败" : "被中断"}：${typeof error === "string" ? error : error?.message ?? payload.summary ?? ""}` };
      }
      return { status: silent(text) ? "silent" : "ok", sessionId, text };
    }
    const session = sessionId ? this.deps.store.session(sessionId) : undefined;
    if (session && typeof session.activeTurnId === "string") {
      const interrupt = this.deps.store.createAction({ principal: "system:automations", key: `${runId}:interrupt`, method: "POST",
        path: `/api/v1/sessions/${sessionId}/interrupt`, body: {}, kind: "interrupt_turn", machineId: parsed.machineId, sessionId });
      try { this.deps.dispatch(interrupt.action, { type: "action.interrupt_turn", actionId: interrupt.action.actionId, sessionId: sessionId! }); } catch {}
    }
    const waiting = session?.activityStatus === "waiting_for_approval" ? "，卡在审批" : session?.activityStatus === "waiting_for_input" ? "，卡在提问" : "";
    return { status: "failed", sessionId, error: `超过 ${agent.timeoutMin ?? 30} 分钟没有结束${waiting}，已中断` };
  }

  private finish(task: Automation, runId: string, result: { status: "ok" | "silent" | "failed"; output?: string; error?: string; sessionId?: string; text?: string }): void {
    this.deps.store.db.prepare("UPDATE automation_runs SET status=?,finished_at=?,output=?,error=?,session_id=COALESCE(?,session_id) WHERE id=?")
      .run(result.status, this.now(), result.output ? clip(result.output) : null, result.error ?? null, result.sessionId ?? null, runId);
    const definition = task.definition!;
    if (result.status === "ok" && result.text) this.targets(definition).forEach((target, index) =>
      this.deps.store.createNotice({ id: `run:${runId}:${index}`, ...target, text: clip(result.text!.trim(), 19_000),
        level: definition.level ?? "notice", source: `automation:${task.id}`, ...(result.sessionId && target.connector !== "app" ? { sessionId: result.sessionId } : {}) }));
    if (result.status === "failed") {
      log.warn({ automation: task.id, runId, error: result.error }, "Automation run failed");
      this.deps.store.createNotice({ id: `run:${runId}:failed`, ...this.options.operatorTarget, level: "alert", source: `automation:${task.id}`,
        text: `⚠️ 定时任务失败：${definition.title}\n${result.error ?? ""}`.slice(0, 2_000), ...(result.sessionId ? { sessionId: result.sessionId } : {}) });
    }
  }

  private targets(definition: AutomationDefinition): NoticeTarget[] {
    return (definition.deliver ?? ["app"]).map((item) => item === "app" ? this.options.operatorTarget : parseNoticeTarget(item)!);
  }

  // ---- proposals ------------------------------------------------------------

  /** An agent's change waits here until the human confirms it; nothing is written or scheduled before. */
  propose(input: { action: "create" | "update" | "delete"; id: string; scope?: string; definition?: unknown; reason?: string }, proposedBy: string): AutomationProposal {
    if (!SLUG.test(input.id)) throw new AutomationError(400, "invalid_id", "id must be a lowercase slug");
    const existing = this.tasks.get(input.id);
    if (input.action === "create" && existing) throw new AutomationError(409, "automation_exists", "automation already exists; propose an update");
    if (input.action !== "create" && !existing) throw new AutomationError(404, "automation_not_found", "automation not found");
    const scope = existing?.scope ?? input.scope;
    if (!scope || !(SLUG.test(scope) || /^_[a-z0-9-]+$/.test(scope))) throw new AutomationError(400, "invalid_scope", "scope is required");
    let definition: AutomationDefinition | null = null;
    if (input.action !== "delete") {
      try { definition = validateDefinition(input.definition); }
      catch (error) { throw new AutomationError(400, "invalid_definition", error instanceof Error ? error.message : String(error)); }
      if (definition.script) {
        const probe: Automation = { id: input.id, scope, dir: join(this.options.dir, scope, input.id), definition, hash: "" };
        try { this.scriptPath(probe); } catch (error) { throw new AutomationError(400, "invalid_script", error instanceof Error ? error.message : String(error)); }
      }
    }
    const id = randomUUID(), now = this.now();
    this.deps.store.db.prepare(`INSERT INTO automation_proposals(id,action,automation_id,scope,definition,previous,reason,proposed_by,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,'pending',?)`).run(id, input.action, input.id, scope, definition ? JSON.stringify(definition) : null,
      existing?.definition ? JSON.stringify(existing.definition) : null, input.reason ?? null, proposedBy, now);
    const verb = { create: "新建", update: "修改", delete: "删除" }[input.action];
    this.deps.store.createNotice({ id: `proposal:${id}`, ...this.options.operatorTarget, level: "alert", source: proposedBy,
      text: `🗓️ 定时任务提案：${verb} ${definition?.title ?? existing?.definition?.title ?? input.id}\n${proposedBy} 提出${input.reason ? `：${input.reason}` : ""}。在控制中心首页确认后才生效。` });
    return this.proposal(id)!;
  }

  proposal(id: string): AutomationProposal | undefined {
    const row = this.deps.store.db.prepare("SELECT * FROM automation_proposals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row && proposalWire(row);
  }

  proposals(status?: string): AutomationProposal[] {
    this.deps.store.db.prepare("UPDATE automation_proposals SET status='expired' WHERE status='pending' AND created_at<?").run(this.now() - PROPOSAL_TTL_MS);
    return (this.deps.store.db.prepare(`SELECT * FROM automation_proposals ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT 100`)
      .all(...(status ? [status] : [])) as Array<Record<string, unknown>>).map(proposalWire);
  }

  /** The human's decision. Allowing writes the definition and commits it; the next reload schedules it. */
  decide(id: string, choice: "allow" | "deny", decidedBy: string): AutomationProposal {
    this.proposals();
    const proposal = this.proposal(id);
    if (!proposal) throw new AutomationError(404, "proposal_not_found", "proposal not found");
    if (proposal.status !== "pending") throw new AutomationError(409, "proposal_not_pending", `proposal is ${proposal.status}`);
    const update = (status: string, error?: string) => this.deps.store.db.prepare("UPDATE automation_proposals SET status=?,error=?,decided_at=?,decided_by=? WHERE id=?")
      .run(status, error ?? null, this.now(), decidedBy, id);
    if (choice === "deny") { update("denied"); return this.proposal(id)!; }
    try {
      const dir = join(this.options.dir, proposal.scope, proposal.automationId), file = join(dir, "automation.yaml");
      if (proposal.action === "delete") rmSync(file, { force: true });
      else { mkdirSync(dir, { recursive: true }); writeFileSync(file, stringifyYaml(proposal.definition)); }
      this.commit(file, `automation(${proposal.scope}/${proposal.automationId}): ${proposal.action}`, `${proposal.proposedBy}, confirmed by ${decidedBy}`);
      update("applied");
      this.reload(true);
    } catch (error) { update("failed", error instanceof Error ? error.message : String(error)); }
    return this.proposal(id)!;
  }

  private commit(file: string, subject: string, by: string): void {
    let repo: string;
    try { repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: this.options.dir, encoding: "utf8" }).trim(); }
    catch { return; }
    const path = relative(repo, file).split(sep).join("/");
    const script = 'm="$1"; shift; git add -A -- "$@" && { git diff --cached --quiet -- "$@" || git commit -q -m "$m" -- "$@"; }';
    const command = ["sh", "-c", script, "automation-commit", `${subject}\n\nby: ${by}`, path];
    const env = { ...process.env, GIT_AUTHOR_NAME: "agent-automations", GIT_AUTHOR_EMAIL: "agent-skills@localhost",
      GIT_COMMITTER_NAME: "agent-automations", GIT_COMMITTER_EMAIL: "agent-skills@localhost" };
    const lock = this.options.lockPath;
    execFileSync(lock ? "flock" : command[0]!, lock ? ["-w", "60", lock, ...command] : command.slice(1), { cwd: repo, env, stdio: "pipe" });
    if (!this.options.push) return;
    const pushEnv = { ...process.env, HOME: process.env.HOME ?? homedir(), GIT_TERMINAL_PROMPT: "0" };
    const push = spawn(lock ? "flock" : "git", lock ? ["-w", "120", lock, "git", "push", "-q"] : ["push", "-q"], { cwd: repo, env: pushEnv, stdio: "ignore" });
    push.on("close", (code) => { if (code !== 0) log.warn({ code }, "Automation push failed; the next write retries"); });
  }
}

function kindOf(definition: AutomationDefinition): string {
  return definition.agent ? definition.script ? "script+agent" : "agent" : definition.script ? "script" : "notify";
}

function targetText(target: NoticeTarget): string {
  return `${target.connector}:${target.roomId}${target.threadId ? `#${target.threadId}` : ""}`;
}

function runWire(row: Record<string, unknown>): AutomationRun {
  return { id: String(row.id), automationId: String(row.automation_id), trigger: String(row.trigger), triggerAt: Number(row.trigger_at),
    startedAt: row.started_at == null ? null : Number(row.started_at), finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    status: row.status as AutomationRun["status"], sessionId: (row.session_id as string | null) ?? null,
    output: (row.output as string | null) ?? null, error: (row.error as string | null) ?? null };
}

function proposalWire(row: Record<string, unknown>): AutomationProposal {
  const json = (value: unknown) => value == null ? null : JSON.parse(String(value));
  return { id: String(row.id), action: row.action as AutomationProposal["action"], automationId: String(row.automation_id), scope: String(row.scope),
    definition: json(row.definition), previous: json(row.previous), reason: (row.reason as string | null) ?? null, proposedBy: String(row.proposed_by),
    status: row.status as AutomationProposal["status"], error: (row.error as string | null) ?? null, createdAt: Number(row.created_at),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at), decidedBy: (row.decided_by as string | null) ?? null };
}

/** GitHub, GitLab and Hermes (generic V1/V2) webhook signatures, as the callers being migrated send them. */
export function verifySignature(headers: Record<string, string | string[] | undefined>, body: Buffer, secret: string, now: number): boolean {
  const header = (name: string) => { const value = headers[name]; return (Array.isArray(value) ? value[0] : value) ?? ""; };
  const equal = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
  const hex = (data: Buffer) => createHmac("sha256", secret).update(data).digest("hex");
  const v2 = header("x-webhook-signature-v2");
  if (v2) {
    const timestamp = header("x-webhook-timestamp"), seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(now / 1_000 - seconds) > 300) return false;
    return equal(v2, hex(Buffer.concat([Buffer.from(`${timestamp}.`), body])));
  }
  if (header("x-hub-signature-256")) return equal(header("x-hub-signature-256"), `sha256=${hex(body)}`);
  if (header("x-gitlab-token")) return equal(header("x-gitlab-token"), secret);
  if (header("x-webhook-signature")) return equal(header("x-webhook-signature"), hex(body));
  return false;
}
