import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ControlClient, explain } from "./api/client";
import { BUILD_VERSION, newerBuild, runningEntry } from "./build";
import { clearDetailStore, openDetailStore } from "./cache";
import { haptic, SHARE_EVENT, takeShare } from "./native/uctw";
import { MessageText } from "./markdown";
import { AgentIcon, machineStyle, Origin } from "./identity";
import { TOOL_TYPES } from "@agent-bridge/transcript";
import { TurnView, DETAIL_MODES, type DetailMode } from "./turn-view";
import { isLive, pendingId, segment, type Pending, type Session, type SessionEvent, type Snapshot } from "./api/types";
import { canCompose, ControlState, unreadCount, type Route, type ViewState } from "./state";
import "./styles.css";

function navigate(path: string) {
  history.pushState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate"));
}
function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={e => {
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); navigate(to); }
  }}>{children}</a>;
}
const labels: Record<string, string> = { active: "正在运行", creating: "启动中", idle: "已空闲",
  waiting_for_approval: "等待审批", waiting_for_input: "等待回答", offline: "已离线", error: "异常", unknown: "未知" };
const title = (s: Session) => s.title || s.promptSummary || s.projectName || "未命名会话";
/** The list's order: the latest prompt, else creation (the server sorts the same way). */
const promptTime = (s: Session) => s.lastPromptAt ?? s.createdAt;
const time = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function Status({ status }: { status: string }) {
  return <span className={`status ${["active", "creating"].includes(status) ? "live" : status.startsWith("waiting") ? "waiting" : ""}`}>
    <span aria-hidden="true" className="dot" />{labels[status] ?? "未知状态"}</span>;
}

const isBusy = (state: ViewState) => Boolean(state.intent && (state.intent.submitting || state.intent.uncertain || state.intent.receipt?.status === "accepted"));

// The relay catalog carries no effort metadata: effort is the agent's setting (same table as the DSH plugin).
const AGENT_EFFORTS: Record<string, string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh"] };
const effortLabels: Record<string, string> = { minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
interface ModelChoice { model: string; effort: string }
function ModelPicker({ control, state, workerId, value, onChange, disabled }: { control: ControlState; state: ViewState; workerId?: string;
  value: ModelChoice; onChange: (v: ModelChoice) => void; disabled?: boolean }) {
  const catalog = workerId ? state.models[workerId] : undefined;
  useEffect(() => { if (workerId && state.writable) void control.loadModels(workerId); }, [control, workerId, state.writable]);
  const models = catalog?.models ?? [];
  const current = models.find(m => m.model === value.model) ?? models.find(m => m.isDefault);
  const listed = current?.supportedReasoningEfforts?.map(e => e.reasoningEffort);
  const efforts = listed?.length ? listed : AGENT_EFFORTS[workerId?.split("@")[0] ?? ""] ?? [];
  return <div className="model-picker">
    <label><span>模型</span><select value={value.model} disabled={disabled || !workerId} onChange={e => onChange({ ...value, model: e.target.value })}>
      <option value="">{catalog?.status === "loading" ? "读取模型…" : "Agent 默认"}</option>
      {models.map(m => <option key={m.id} value={m.model}>{m.displayName}{m.isDefault ? "（默认）" : ""}</option>)}
      {value.model && !models.some(m => m.model === value.model) && <option value={value.model}>{value.model}</option>}
    </select></label>
    {efforts.length > 0 && <label><span>思考程度</span><select value={value.effort} disabled={disabled || !workerId} onChange={e => onChange({ ...value, effort: e.target.value })}>
      <option value="">Agent 默认</option>{efforts.map(e => <option key={e} value={e}>{effortLabels[e] ?? e}</option>)}</select></label>}
    {catalog?.status === "error" && <small className="hint">模型目录不可用：{catalog.error} <button type="button" className="quiet" onClick={() => void control.loadModels(workerId!)}>重试</button></small>}
  </div>;
}
const modelBody = (v: ModelChoice) => ({ ...(v.model ? { model: v.model } : {}), ...(v.effort ? { reasoningEffort: v.effort } : {}) });

function AttachmentList({ control, state, id }: { control: ControlState; state: ViewState; id: string }) {
  const rows = state.uploads[id] ?? [];
  return rows.length > 0 ? <ul className="attachment-list">{rows.map(u => <li key={u.localId} className={`attachment ${u.status}`}>
    {u.preview ? <img src={u.preview} alt="" /> : <span className="attachment-thumb" aria-hidden="true">文件</span>}<span>{u.status === "uploading" ? "上传中…" : u.status === "error" ? u.error : u.name}</span>
    <button type="button" className="quiet" aria-label={`移除 ${u.name}`} onClick={() => control.removeUpload(id, u.localId)}>×</button></li>)}</ul> : null;
}
function AttachButton({ control, id, disabled, compact }: { control: ControlState; id: string; disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx" multiple hidden onChange={e => {
      control.addFiles(id, [...(e.target.files ?? [])]); e.target.value = "";
    }} />
    <button type="button" className={`quiet attach ${compact ? "icon-button" : ""}`} disabled={disabled} aria-label="添加图片或文件"
      onClick={() => input.current?.click()}>{compact ? "＋" : "＋ 图片 / 文件"}</button></>;
}
const attachmentBody = (state: ViewState, id: string) => {
  const refs = (state.uploads[id] ?? []).flatMap(u => u.status === "ready" && u.ref ? [u.ref] : []);
  return refs.length ? { attachments: refs } : {};
};
const uploading = (state: ViewState, id: string) => (state.uploads[id] ?? []).some(u => u.status === "uploading");
const pasteImages = (control: ControlState, id: string) => (e: React.ClipboardEvent) => {
  const files = [...e.clipboardData.files].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); control.addFiles(id, files); }
};
const submitWithKeyboard = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey
    || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
  e.preventDefault();
  if (e.repeat) return;
  const form = e.currentTarget.form, submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit && !submit.disabled) form!.requestSubmit(submit);
};

// Never a real option label: the API rejects empty/control-only answers.
const OTHER = "\0other";
const choiceLabels: Record<string, string> = { allow: "允许", deny: "拒绝", "allow-session": "本会话始终允许", "allow-always": "永久允许", "allow-similar": "允许类似的操作", "allow-session-all": "本会话全部允许" };
/** What a wider choice lets through besides this one call; shown inside its button. */
const choiceNotes: Record<string, string> = {
  "allow-similar": "放行这一条，并让审核员记住这类操作，以后自动放行",
  "allow-session-all": "放行这一条，这个会话之后的所有操作（包括超出边界的）都不再问你；可在会话里撤销",
  "allow-session": "放行这个工具在本会话的所有后续调用，不只这一条",
  "allow-always": "这台机器之后的所有会话都放行（写入 Claude 的 settings.json）",
};
const riskLabels: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险" };
const LONG_LINES = 12, LONG_CHARS = 700;
/** Long text shown whole on demand, never in a small scrolling box. */
function LongText({ text, className = "" }: { text: string; className?: string }) {
  const lines = text.split("\n").length, long = lines > LONG_LINES || text.length > LONG_CHARS;
  const [open, setOpen] = useState(false);
  return <div className={`long-text ${long && !open ? "clamped" : ""}`}>
    <pre className={className}>{text}</pre>
    {long && <button type="button" className="quiet expand" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? "收起" : `展开全部（${lines} 行）`}</button>}
  </div>;
}
function ApprovalCard({ control, pending, disabled }: { control: ControlState; pending: Pending; disabled: boolean }) {
  const id = pendingId(pending), choices = pending.choices?.length ? pending.choices : ["allow", "deny"];
  const main = choices.filter(c => c === "allow" || c === "deny"), wider = choices.filter(c => c !== "allow" && c !== "deny");
  const decide = (choice: string) => { haptic("tick"); void control.submit(`/approvals/${segment(id)}/decision`, { choice }); };
  const a = pending.analysis;
  return <div className="pending-item approval"><div className="pending-kind">审批{pending.kind ? ` · ${pending.kind}` : ""}
    {a && <span className={`risk-pill risk-${a.risk}`}>{riskLabels[a.risk] ?? a.risk}</span>}</div>
    {a && <div className={`analysis risk-${a.risk}`}><div className="analysis-head">审核员的判断</div>
      <p className="analysis-what">{a.what}</p>{a.reason && <p className="analysis-reason">{a.reason}</p>}</div>}
    <LongText className="pending-summary" text={pending.summary ?? "（无摘要）"} />
    <div className="decision-main">{main.map(choice => <button key={choice} type="button" disabled={disabled}
      className={choice === "allow" ? "primary" : "danger"} onClick={() => decide(choice)}>{choiceLabels[choice]}</button>)}</div>
    {wider.map(choice => <button key={choice} type="button" disabled={disabled} className={`decision-wide ${choice === "allow-similar" ? "suggested" : ""}`}
      onClick={() => decide(choice)}><span>{choiceLabels[choice] ?? choice}</span>{choiceNotes[choice] && <small>{choiceNotes[choice]}</small>}</button>)}
  </div>;
}

function InputCard({ control, state, pending, disabled }: { control: ControlState; state: ViewState; pending: Pending; disabled: boolean }) {
  const questions = pending.questions ?? [], pid = pendingId(pending), answers = state.answers[pid] ?? {};
  const pick = (qid: string, choice: string) => control.setAnswer(pid, qid, { ...answers[qid], choice });
  if (questions.some(q => q.isSecret)) return <div className="pending-item"><div className="pending-kind">问题</div>
    {questions.map(q => <p key={q.id}>{q.isSecret ? "包含保密输入，请在本机安全回答" : q.question}</p>)}</div>;
  const value = (id: string) => (answers[id]?.choice === OTHER ? answers[id].other ?? "" : answers[id]?.choice ?? "").trim();
  const complete = questions.length > 0 && questions.every(q => value(q.id));
  return <form className="pending-item" onSubmit={e => {
    e.preventDefault(); if (!complete || disabled) return;
    haptic("tick");
    void control.submit(`/user-input/${segment(pid)}/response`,
      { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [value(q.id)] }])) });
  }}><div className="pending-kind">问题</div>
    {questions.map(q => <fieldset key={q.id} className="question"><legend>{q.header && <strong>{q.header} · </strong>}{q.question}</legend>
      {q.options?.length ? <>{q.options.map(o => <label key={o.label} className="option">
        <input type="radio" name={`${pid}:${q.id}`} checked={answers[q.id]?.choice === o.label} onChange={() => pick(q.id, o.label)} />
        <span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}
        {q.isOther && <label className="option"><input type="radio" name={`${pid}:${q.id}`} checked={answers[q.id]?.choice === OTHER}
          onChange={() => pick(q.id, OTHER)} /><span>其他</span></label>}
        {answers[q.id]?.choice === OTHER && <input aria-label="其他答案" value={answers[q.id].other ?? ""}
          onChange={e => control.setAnswer(pid, q.id, { choice: OTHER, other: e.target.value })} />}</>
        : <textarea rows={2} aria-label={q.question} value={answers[q.id]?.choice ?? ""} onChange={e => pick(q.id, e.target.value)} />}
    </fieldset>)}
    <button className="primary" disabled={disabled || !complete}>提交回答</button>
  </form>;
}

interface MemoryReview { id: string; writer: string; tool: string; args: Record<string, unknown>; summary: string;
  status: string; reason: string | null; createdAt: number }
/** Memory/skill writes the reviewer handed to the human (docs/agent-dispatch-and-review.zh.md). */
function MemoryReviewPanel({ writable }: { writable: boolean }) {
  const [reviews, setReviews] = useState<MemoryReview[]>([]), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const client = useRef<ControlClient>();
  const load = async () => {
    try { setReviews((await client.current!.request<{ data: MemoryReview[] }>("/memory-reviews?status=waiting_human")).data); setError(""); }
    catch (e) { setError(explain(e)); }
  };
  useEffect(() => {
    client.current = new ControlClient("", () => {}, "/control/api/v1"); void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { clearInterval(timer); client.current?.dispose(); };
  }, []);
  const decide = async (id: string, choice: "allow" | "deny") => {
    setBusy(id);
    try { await client.current!.request(`/memory-reviews/${segment(id)}/decision`, { body: { choice } }); await load(); }
    catch (e) { setError(explain(e)); } finally { setBusy(""); }
  };
  if (!reviews.length && !error) return null;
  return <aside className="pending-panel"><strong>待你确认的记忆写入</strong>
    {error && <p className="error">{error}</p>}
    {reviews.map(r => <div key={r.id} className="pending-item">
      <div className="pending-kind">{r.writer} · {time(r.createdAt)}</div>
      <LongText className="pending-summary" text={r.summary} />
      {r.reason && <p className="hint">审核：{r.reason}</p>}
      <details><summary>完整内容</summary><pre className="pending-summary">{JSON.stringify(r.args, null, 2)}</pre></details>
      {writable && <div className="row-actions">
        <button type="button" className="primary" disabled={busy === r.id} onClick={() => void decide(r.id, "allow")}>允许写入</button>
        <button type="button" className="danger" disabled={busy === r.id} onClick={() => void decide(r.id, "deny")}>拒绝</button></div>}
    </div>)}
  </aside>;
}

interface ToolApproval { id: string; tool: string; args: Record<string, unknown>; caller: string; risk: string; createdAt: number }
/** Calls into the central tool library waiting for you (docs/tool-hub-design.zh.md); the caller blocks until you decide. */
function ToolApprovalPanel({ writable }: { writable: boolean }) {
  const [rows, setRows] = useState<ToolApproval[]>([]), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const client = useRef<ControlClient>();
  const load = async () => {
    try { setRows((await client.current!.request<{ data: ToolApproval[] }>("/tool-approvals?status=pending")).data); setError(""); }
    catch (e) { const text = explain(e); if (!/not.found|404/i.test(text)) setError(text); }
  };
  useEffect(() => {
    client.current = new ControlClient("", () => {}, "/control/api/v1"); void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10_000);
    return () => { clearInterval(timer); client.current?.dispose(); };
  }, []);
  const decide = async (id: string, choice: "allow" | "deny") => {
    setBusy(id);
    try { await client.current!.request(`/tool-approvals/${segment(id)}/decision`, { body: { choice } }); await load(); }
    catch (e) { setError(explain(e)); } finally { setBusy(""); }
  };
  if (!rows.length && !error) return null;
  return <aside className="pending-panel"><strong>待你确认的工具调用</strong>
    {error && <p className="error">{error}</p>}
    {rows.map(r => <div key={r.id} className="pending-item">
      <div className="pending-kind">{r.tool} · {r.caller} · {time(r.createdAt)}</div>
      <LongText className="pending-summary" text={JSON.stringify(r.args, null, 2)} />
      {writable && <div className="row-actions">
        <button type="button" className="primary" disabled={busy === r.id} onClick={() => void decide(r.id, "allow")}>允许</button>
        <button type="button" className="danger" disabled={busy === r.id} onClick={() => void decide(r.id, "deny")}>拒绝</button></div>}
    </div>)}
  </aside>;
}

interface AutomationProposal { id: string; action: "create" | "update" | "delete"; automationId: string; scope: string;
  definition: Record<string, unknown> | null; previous: Record<string, unknown> | null; reason: string | null; proposedBy: string; createdAt: number;
  review?: string | null }
interface AutomationRun { id: string; trigger: string; triggerAt: number; startedAt: number | null; finishedAt: number | null;
  status: string; sessionId: string | null; output: string | null; error: string | null }
interface AutomationRow { id: string; scope: string; title: string; kind: string | null; trigger: string | null; error: string | null;
  schedule: { cron?: string; everyMinutes?: number; tz?: string } | null;
  /** A one-time task's local time, and whether it has run. */
  at: string | null; completed: boolean;
  /** Where a webhook task is called. */
  hooks?: string[];
  enabled: boolean; paused: boolean; nextAt: number | null; deliver: string[]; lastRun: AutomationRun | null }
interface AutomationDetail extends AutomationRow { yaml: string | null; runs: AutomationRun[];
  definition: { deliver?: string[]; session?: { id: string; note?: string }; room?: { to: string; agent?: unknown } } | null }
/** The task's own deliver list, as written (none means App). */
const rawDeliver = (t: AutomationDetail) => t.definition?.deliver ?? ["app"];
const KIND_LABELS: Record<string, string> = { notify: "通知", script: "脚本", agent: "新会话", "script+agent": "脚本+新会话",
  session: "唤回会话", room: "推到房间", "script+room": "脚本+推到房间" };
const TRIGGER_LABELS: Record<string, string> = { schedule: "定时", webhook: "webhook", manual: "手动", at: "一次" };
/** Broken, or its last run failed or was missed: these come first, with what went wrong. */
const needsYou = (t: AutomationRow) => Boolean(t.error) || t.lastRun?.status === "failed" || t.lastRun?.status === "missed";
const whenText = (t: AutomationRow) => t.trigger === "webhook" ? "webhook 触发" : t.at ? `一次：${t.at}`
  : t.schedule?.cron ? `cron ${t.schedule.cron}${t.schedule.tz ? ` (${t.schedule.tz})` : ""}`
  : t.schedule?.everyMinutes ? `每 ${t.schedule.everyMinutes} 分钟` : "";
const tookText = (r: AutomationRun) => r.startedAt && r.finishedAt ? `${Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} 秒` : "";
function RunPill({ status }: { status: string }) {
  const tone = status === "failed" || status === "missed" ? "risk-high" : status === "ok" ? "risk-low" : "";
  return <span className={`risk-pill run-pill ${tone}`}>{RUN_LABELS[status] ?? status}</span>;
}
const VERBS = { create: "新建", update: "修改", delete: "删除" } as const;
const RUN_LABELS: Record<string, string> = { ok: "已投递", silent: "无输出", failed: "失败", skipped: "跳过", missed: "错过", running: "运行中" };
/** Scheduled and webhook tasks, and the changes agents proposed (docs/automations-design.zh.md): only you confirm them. */
function AutomationPanel({ writable, proposalsOnly }: { writable: boolean; proposalsOnly?: boolean }) {
  const [proposals, setProposals] = useState<AutomationProposal[]>([]), [tasks, setTasks] = useState<AutomationRow[]>([]);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const client = useRef<ControlClient>();
  const load = async () => {
    try {
      const [p, t] = await Promise.all([client.current!.request<{ data: AutomationProposal[] }>("/automations/proposals?status=pending"),
        client.current!.request<{ data: AutomationRow[] }>("/automations")]);
      setProposals(p.data); setTasks(t.data); setError("");
    } catch (e) { const text = explain(e); if (!/not.found|404/i.test(text)) setError(text); }
  };
  useEffect(() => {
    client.current = new ControlClient("", () => {}, "/control/api/v1"); void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { clearInterval(timer); client.current?.dispose(); };
  }, []);
  const act = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    try { await client.current!.request(path, { body }); await load(); }
    catch (e) { setError(explain(e)); } finally { setBusy(""); }
  };
  if (!proposals.length && !tasks.length && !error) return null;
  return <>
    {(proposals.length > 0 || error) && <aside className="pending-panel"><strong>待你确认的定时任务</strong>
      {error && <p className="error">{error}</p>}
      {proposals.map(p => <div key={p.id} className="pending-item">
        <div className="pending-kind">{VERBS[p.action]} {p.scope}/{p.automationId} · {p.proposedBy} · {time(p.createdAt)}</div>
        {p.reason && <p className="hint">{p.reason}</p>}
        {p.review && <p className="attention">审核员：{p.review}</p>}
        {p.definition && <LongText className="pending-summary" text={JSON.stringify(p.definition, null, 2)} />}
        {p.previous && <details><summary>当前定义</summary><pre className="pending-summary">{JSON.stringify(p.previous, null, 2)}</pre></details>}
        {writable && <div className="row-actions">
          <button type="button" className="primary" disabled={busy === p.id} onClick={() => void act(p.id, `/automations/proposals/${segment(p.id)}/decision`, { choice: "allow" })}>确认生效</button>
          <button type="button" className="danger" disabled={busy === p.id} onClick={() => void act(p.id, `/automations/proposals/${segment(p.id)}/decision`, { choice: "deny" })}>拒绝</button></div>}
      </div>)}
    </aside>}
    {!proposalsOnly && tasks.length > 0 && <Link to="/control/automations" className="pending-panel automation-link"><strong>定时任务</strong> · {tasks.length} 个
      {tasks.some(needsYou) ? <span className="attention"> · {tasks.filter(needsYou).length} 个要处理</span> : <span className="hint"> · 都正常</span>}<span className="row-arrow" aria-hidden="true">↗</span></Link>}
  </>;
}

/**
 * Every scheduled and webhook task, ordered by what needs you: broken or failed ones first, then what runs
 * next, then the webhook-triggered ones, and paused or disabled ones last (folded).
 */
function Automations({ writable }: { writable: boolean }) {
  const [tasks, setTasks] = useState<AutomationRow[]>(), [error, setError] = useState("");
  useEffect(() => {
    const client = new ControlClient("", () => {}, "/control/api/v1");
    const load = () => client.request<{ data: AutomationRow[] }>("/automations").then(r => { setTasks(r.data); setError(""); }, e => setError(explain(e)));
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { clearInterval(timer); client.dispose(); };
  }, []);
  const all = tasks ?? [], broken = all.filter(needsYou), rest = all.filter(t => !needsYou(t));
  const done = rest.filter(t => t.completed), off = rest.filter(t => !t.completed && (t.paused || !t.enabled)), on = rest.filter(t => !t.completed && !t.paused && t.enabled);
  const scheduled = on.filter(t => t.nextAt).sort((a, b) => a.nextAt! - b.nextAt!), hooks = on.filter(t => !t.nextAt);
  const row = (t: AutomationRow) => <Link key={t.id} to={`/control/automations/${segment(t.id)}`} className="session-row automation-row">
    <div className="session-row-top"><span className="hint">{t.scope} · {KIND_LABELS[t.kind ?? ""] ?? t.kind ?? "?"}</span>
      <span className="row-end">{t.lastRun && <RunPill status={t.lastRun.status} />}{t.nextAt && <time title="下次运行">{time(t.nextAt)}</time>}</span></div>
    <h2>{t.title}</h2>
    {t.error ? <p className="attention">定义有误：{t.error}</p>
      : needsYou(t) && t.lastRun ? <p className="attention">{time(t.lastRun.triggerAt)} {RUN_LABELS[t.lastRun.status]}{t.lastRun.error ? `：${t.lastRun.error.slice(0, 160)}` : ""}</p>
      : <p>{whenText(t)}</p>}
    <span className="row-arrow" aria-hidden="true">↗</span>
  </Link>;
  return <section className="page">
    <TopBar back="/control/sessions" title="定时任务" sub={tasks ? `${all.length} 个${broken.length ? ` · ${broken.length} 个要处理` : ""}` : "正在读取…"} />
    {error && <div className="error" role="alert">{error}</div>}
    <AutomationPanel writable={writable} proposalsOnly />
    {broken.length > 0 && <><h3 className="list-group">要处理</h3><div className="session-list">{broken.map(row)}</div></>}
    {scheduled.length > 0 && <><h3 className="list-group">接下来</h3><div className="session-list">{scheduled.map(row)}</div></>}
    {hooks.length > 0 && <><h3 className="list-group">webhook 触发</h3><div className="session-list">{hooks.map(row)}</div></>}
    {off.length > 0 && <details><summary className="list-group">已暂停或未启用 · {off.length}</summary><div className="session-list">{off.map(row)}</div></details>}
    {done.length > 0 && <details><summary className="list-group">已完成 · {done.length}</summary><div className="session-list">{done.map(row)}</div></details>}
    {tasks && !all.length && <div className="empty">还没有定时任务。<p>让 agent 用 automation_propose 提一个，确认后生效。</p></div>}
  </section>;
}

interface NoticeTarget { target: string; name: string; kind: string }
const TARGET_ICONS: Record<string, string> = { app: "📱", matrix: "💬", call: "📞" };
/** Where a task delivers, picked from App, the scope-bound rooms and whom call-bridge can ring; saved on its own. */
function DeliverPicker({ id, current, writable, saved }: { id: string; current: string[]; writable: boolean; saved: () => void }) {
  const [targets, setTargets] = useState<NoticeTarget[]>([]), [picked, setPicked] = useState(current), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const client = new ControlClient("", () => {}, "/control/api/v1");
    void client.request<{ data: NoticeTarget[] }>("/notice-targets").then(r => setTargets(r.data), e => setError(explain(e))).finally(() => client.dispose());
  }, []);
  useEffect(() => setPicked(current), [current.join("\n")]);
  // Targets the task names that the list does not know (a room bound to no scope) stay visible and checked.
  const known = new Set(targets.map(t => t.target)), all = [...targets, ...current.filter(t => !known.has(t)).map(t => ({ target: t, name: t, kind: t.split(":", 1)[0]! }))];
  const changed = picked.length !== current.length || picked.some(t => !current.includes(t));
  const toggle = (target: string) => setPicked(picked.includes(target) ? picked.filter(t => t !== target) : [...picked, target]);
  const save = async () => {
    setBusy(true); setError("");
    const client = new ControlClient("", () => {}, "/control/api/v1");
    try { await client.request(`/automations/${segment(id)}/deliver`, { body: { deliver: picked.length ? picked : ["app"] } }); saved(); }
    catch (e) { setError(explain(e)); } finally { setBusy(false); client.dispose(); }
  };
  return <div className="pending-panel"><strong>发往</strong>
    {error && <p className="attention">{error}</p>}
    <div className="target-list">{all.map(t => <label key={t.target} className={`target-option ${picked.includes(t.target) ? "on" : ""}`}>
      <input type="checkbox" checked={picked.includes(t.target)} disabled={!writable || busy} onChange={() => toggle(t.target)} />
      <span aria-hidden="true">{TARGET_ICONS[t.kind] ?? "•"}</span><span>{t.name}</span></label>)}</div>
    {!picked.length && <small className="hint">都不勾时发到 App。</small>}
    {writable && changed && <div className="row-actions"><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存发往"}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => setPicked(current)}>还原</button></div>}
  </div>;
}

/** A webhook task's addresses, a curl line to copy, and a sample payload to try it with. */
function HookPanel({ task, writable, run }: { task: AutomationDetail; writable: boolean; run: (payload: Record<string, unknown>) => Promise<boolean | undefined> }) {
  const [sample, setSample] = useState('{"text": "试发一条", "agent": false}'), [bad, setBad] = useState("");
  const hooks = task.hooks ?? [], first = hooks.find(h => !h.includes("127.0.0.1")) ?? hooks[0];
  const tryIt = () => {
    try { const payload = JSON.parse(sample); setBad(""); void run(payload && typeof payload === "object" ? payload : { value: payload }); }
    catch { setBad("不是合法的 JSON"); }
  };
  return <div className="pending-panel"><strong>webhook 地址</strong>
    {hooks.map(h => <p key={h} className="hook-url">{h}</p>)}
    {first && <pre className="pending-summary">{`curl -X POST ${first} -H 'Content-Type: application/json' -d '${sample.replace(/'/g, "'\\''")}'`}</pre>}
    {writable && <><textarea className="yaml-editor" rows={3} value={sample} spellCheck={false} onChange={e => setSample(e.target.value)} />
      {bad && <p className="attention">{bad}</p>}
      <div className="row-actions"><button type="button" onClick={tryIt}>试发一条</button></div></>}
  </div>;
}

/** One task: what it is, its recent runs (a failed one opens on its error and output), and its definition to edit or delete. */
function AutomationPage({ id, writable }: { id: string; writable: boolean }) {
  const [task, setTask] = useState<AutomationDetail>(), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<string>(), [notice, setNotice] = useState("");
  const client = useRef<ControlClient>();
  const load = async () => {
    try { setTask(await client.current!.request<AutomationDetail>(`/automations/${segment(id)}`)); setError(""); }
    catch (e) { setError(explain(e)); }
  };
  useEffect(() => {
    client.current = new ControlClient("", () => {}, "/control/api/v1"); void load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => { clearInterval(timer); client.current?.dispose(); };
  }, [id]);
  const act = async (key: string, path: string, body: unknown, done?: string) => {
    setBusy(key); setNotice("");
    try { await client.current!.request(path, { body }); if (done) setNotice(done); await load(); return true; }
    catch (e) { setError(explain(e)); return false; } finally { setBusy(""); }
  };
  const save = async () => { if (await act("save", `/automations/${segment(id)}/edit`, { yaml: draft }, "已保存并提交到 agent-skills。")) setDraft(undefined); };
  const remove = async () => {
    if (!confirm(`删除定时任务「${task?.title ?? id}」？它的定义会从 agent-skills 删除（git 历史里还在）。`)) return;
    if (await act("delete", `/automations/${segment(id)}/delete`, {})) navigate("/control/automations");
  };
  const failed = task?.runs.find(r => r.status === "failed" || r.status === "missed");
  return <section className="page">
    <TopBar back="/control/automations" title={task?.title ?? id} sub={task ? `${task.scope}/${task.id} · ${KIND_LABELS[task.kind ?? ""] ?? task.kind ?? "?"}` : "正在读取…"} />
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {task && <>
      <div className="pending-panel">
        {task.error && <p className="attention">定义有误：{task.error}</p>}
        <p>{[whenText(task), task.completed ? "已完成" : task.nextAt ? `下次 ${time(task.nextAt)}` : "", task.paused ? "已暂停" : !task.enabled ? "未启用" : ""].filter(Boolean).join(" · ")}</p>
        {task.definition?.session && <p className="hint">唤回会话 <Link to={`/control/sessions/${segment(task.definition.session.id)}`} className="inline">{task.definition.session.id.slice(0, 18)}…</Link>{task.definition.session.note ? `：${task.definition.session.note}` : ""}</p>}
        {task.definition?.room && <p className="hint">推到房间{task.definition.room.agent ? "，需要时交给房间当前的会话" : ""}</p>}
        {writable && <div className="row-actions">
          <button type="button" disabled={Boolean(busy) || Boolean(task.error)} onClick={() => void act("run", `/automations/${segment(id)}/run`, {}, "已开始运行，结果稍后出现在下面。")}>立即运行</button>
          <button type="button" className="quiet" disabled={Boolean(busy) || Boolean(task.error)} onClick={() => void act("pause", `/automations/${segment(id)}/${task.paused ? "resume" : "pause"}`, {})}>{task.paused ? "恢复" : "暂停"}</button>
          <button type="button" className="quiet" disabled={Boolean(busy) || !task.yaml} onClick={() => setDraft(draft === undefined ? task.yaml ?? "" : undefined)}>{draft === undefined ? "编辑" : "取消编辑"}</button>
          <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void remove()}>删除</button></div>}
      </div>
      {task.trigger === "webhook" && <HookPanel task={task} writable={writable} run={(payload) => act("run", `/automations/${segment(id)}/run`, { payload }, "已试发，结果稍后出现在下面。")} />}
      {task.definition && <DeliverPicker id={id} current={rawDeliver(task)} writable={writable} saved={() => { setNotice("已保存发往。"); void load(); }} />}
      {draft !== undefined && <div className="pending-panel"><strong>编辑定义（YAML）</strong>
        <textarea className="yaml-editor" value={draft} spellCheck={false} onChange={e => setDraft(e.target.value)} rows={Math.min(30, Math.max(8, draft.split("\n").length + 1))} />
        <div className="row-actions"><button type="button" className="primary" disabled={busy === "save" || draft === task.yaml} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存"}</button></div>
        <small className="hint">保存前会校验；生效方式和确认 agent 的提案一样，写入 agent-skills 并提交。</small></div>}
      {draft === undefined && task.yaml && <details className="pending-panel"><summary><strong>定义</strong></summary><pre className="pending-summary">{task.yaml}</pre></details>}
      <h3 className="list-group">最近运行</h3>
      {!task.runs.length && <div className="empty">还没有运行过。</div>}
      <div className="run-list">{task.runs.map(r => <details key={r.id} className={`run-item ${r.status}`} open={r === failed}>
        <summary><RunPill status={r.status} /><time>{time(r.triggerAt)}</time><span className="hint">{TRIGGER_LABELS[r.trigger] ?? r.trigger}{tookText(r) ? ` · ${tookText(r)}` : ""}</span></summary>
        {r.error && <LongText className="pending-summary error-text" text={r.error} />}
        {r.output ? <LongText className="pending-summary" text={r.output} /> : !r.error && <p className="hint">没有输出。</p>}
        {r.sessionId && <Link to={`/control/sessions/${segment(r.sessionId)}`} className="hint">打开这次运行的会话 ↗</Link>}
      </details>)}</div>
    </>}
  </section>;
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const [control, setControl] = useState<ControlState>();
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0), [serverVersion, setServerVersion] = useState("unknown");
  const active = useRef<ControlState>();
  useEffect(() => {
    const change = () => setPath(location.pathname);
    window.addEventListener("popstate", change);
    // Discard legacy token links without reading or forwarding the credential.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const client = new ControlClient("", () => {}, "/control/api/v1");
    setError("");
    void (async () => {
      try {
        const access = await client.request<{ writable: boolean; version?: string }>("/access");
        const [snapshot, store] = await Promise.all([client.request<Snapshot>("/snapshot?sessionLimit=50"), openDetailStore()]);
        if (cancelled) return;
        const instance = new ControlState("", access.writable, snapshot, () => {
          active.current?.dispose(); active.current = undefined; setControl(undefined); clearDetailStore();
          setError("连接已失效，请重新连接；外网访问请先完成 Cloudflare Access 验证。");
        }, navigate, "/control/api/v1", store);
        active.current = instance; setServerVersion(access.version ?? "unknown"); setControl(instance);
        if (!/^\/control\/(sessions(?:\/[^/]+)?|new|automations(?:\/[^/]+)?)\/?$/.test(location.pathname)) navigate("/control/sessions");
      } catch (e) { if (!cancelled) setError(explain(e)); }
      finally { client.dispose(); }
    })();
    return () => { cancelled = true; client.dispose(); active.current?.dispose(); active.current = undefined; };
  }, [attempt]);
  if (!control) return <main className="login-shell">
    <div className="brand"><span className="brand-mark">ab</span><span>AGENT BRIDGE</span></div>
    <h1>控制中心</h1>
    {error ? <><div role="alert" className="error">{error}</div><button className="primary" onClick={() => setAttempt(n => n + 1)}>重新连接</button></>
      : <p role="status" className="muted">正在连接…</p>}
  </main>;
  return <Center control={control} path={path} serverVersion={serverVersion} />;
}

function Center({ control, path, serverVersion }: { control: ControlState; path: string; serverVersion: string }) {
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  let route: Route;
  const match = path.match(/^\/control\/sessions\/([^/]+)\/?$/), task = path.match(/^\/control\/automations(?:\/([^/]+))?\/?$/);
  try {
    route = match ? { page: "detail", id: decodeURIComponent(match[1]) }
      : task ? { page: "automations", id: task[1] ? decodeURIComponent(task[1]) : undefined }
      : { page: path === "/control/new" ? "new" : "sessions" };
  } catch { route = { page: "sessions" }; }
  // Before paint: a cached detail replaces the previous page's state in the first visible frame.
  useLayoutEffect(() => { void control.open(route); }, [control, path]);
  useEffect(() => {
    const visible = () => control.setVisible(document.visibilityState === "visible" && navigator.onLine);
    const hide = () => control.setVisible(false);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", visible);
    window.addEventListener("online", visible); window.addEventListener("offline", visible); visible();
    return () => {
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", visible); window.removeEventListener("online", visible); window.removeEventListener("offline", visible);
    };
  }, [control]);
  // UCTW v2 shares: on the app's event, and on start or return in case the event fired before the page listened.
  useEffect(() => {
    const pull = () => {
      if (document.visibilityState !== "visible") return;
      const share = takeShare(); if (!share) return;
      haptic("tick"); control.receiveShare(share);
    };
    window.addEventListener(SHARE_EVENT, pull); document.addEventListener("visibilitychange", pull); pull();
    return () => { window.removeEventListener(SHARE_EVENT, pull); document.removeEventListener("visibilitychange", pull); };
  }, [control]);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const running = runningEntry(); if (!running) return;
    const check = () => { if (document.visibilityState === "visible") void newerBuild(running).then(newer => { if (newer) setStale(true); }); };
    const timer = setInterval(check, 5 * 60_000);
    // On return the conversation's requests go first: over a slow link the page check would compete with them.
    let later: ReturnType<typeof setTimeout> | undefined;
    const returned = () => { clearTimeout(later); if (document.visibilityState === "visible") later = setTimeout(check, 5_000); };
    document.addEventListener("visibilitychange", returned);
    return () => { clearInterval(timer); clearTimeout(later); document.removeEventListener("visibilitychange", returned); };
  }, []);
  // Banners sit between each page's top bar and its content.
  const banners = <>
    {stale && <aside className="action-banner stale-banner" role="status"><div><strong>控制中心已更新</strong>
      <p>这个页面还是旧版本，刷新后才能使用新功能。</p></div>
      <button className="primary" onClick={() => location.reload()}>刷新</button></aside>}
    {state.error && <div className="error" role="alert">{state.error}<button className="quiet" onClick={() => void control.refresh()}>刷新</button></div>}
  </>;
  return <About.Provider value={{ server: serverVersion, writable: state.writable }}><div className="shell">
    {(state.loading || state.syncing) && <div className="loading-bar" role="progressbar" aria-label="正在加载" />}
    <ActionView control={control} state={state} />
    {state.share && <SharePicker control={control} state={state} />}
    {route.page === "automations" ? route.id ? <AutomationPage key={route.id} id={route.id} writable={state.writable} /> : <Automations writable={state.writable} />
      : route.page === "sessions" ? <Sessions control={control} state={state} banners={banners} />
      : route.page === "new" ? <NewSession control={control} state={state} banners={banners} />
        : <Detail key={route.id} control={control} state={state} id={route.id!} banners={banners} />}
  </div></About.Provider>;
}

/** What the menu's last line reports: versions and access, kept off the main screen. */
const About = React.createContext({ server: "unknown", writable: false });
/**
 * Each page's top bar: navigation and title only. Actions live at the bottom, in the thumb's reach;
 * the rarely used ones (refresh, display, details, versions) open from ⋯ as a bottom sheet.
 */
function TopBar({ back, title, sub, menu }: { back?: string; title: React.ReactNode; sub?: React.ReactNode;
  menu?: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false), about = useContext(About), close = () => setOpen(false);
  return <>
    <header className="topbar">
      {back ? <Link to={back} className="back icon-button" aria-label="返回">‹</Link>
        : <Link to="/control/sessions" className="brand-mark" aria-label="控制中心">ab</Link>}
      <div className="topbar-title"><h1>{title}</h1>{sub && <div className="topbar-sub">{sub}</div>}</div>
      <button type="button" className="quiet icon-button menu-button" aria-label="更多" aria-haspopup="dialog" onClick={() => setOpen(true)}>⋯</button>
    </header>
    {open && <Sheet label="更多" onClose={close}>{menu?.(close)}
      <p className="about">AGENT BRIDGE · 页面 v{BUILD_VERSION} · 服务 v{about.server} · {about.writable ? "操作模式" : "只读模式"}</p></Sheet>}
  </>;
}
function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()}>
      <div className="sheet-grip" aria-hidden="true" />{children}
      <button type="button" className="sheet-close" onClick={onClose}>关闭</button></div>
  </div>;
}
/** The bottom dock's height, so the new-content button, toasts and scroll targets clear it. */
const dockObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(([entry]) =>
  document.documentElement.style.setProperty("--dock-h", `${Math.round((entry.target as HTMLElement).getBoundingClientRect().height)}px`));
const dockRef = (element: HTMLElement | null) => {
  dockObserver?.disconnect();
  if (element) dockObserver?.observe(element); else document.documentElement.style.removeProperty("--dock-h");
};

/** Where a share from another app should go; it is only filled in, never sent. */
function SharePicker({ control, state }: { control: ControlState; state: ViewState }) {
  const share = state.share!, targets = state.sessions.filter(s => canCompose(state, s)).slice(0, 12);
  const choose = (id: string) => {
    haptic("tick"); control.applyShare(id, share);
    navigate(id === "new" ? "/control/new" : `/control/sessions/${segment(id)}`);
  };
  return <aside className="share-sheet" role="dialog" aria-label="发送分享的内容">
    <div className="share-head"><strong>分享到哪个对话？</strong>
      <button type="button" className="quiet" onClick={() => control.dismissShare()}>取消</button></div>
    {share.text.trim() && <p className="share-text">{share.text}</p>}
    {share.attachments.length > 0 && <small className="hint">{share.attachments.length} 张图片</small>}
    <p className="hint">内容会填进输入框，确认后再发送。</p>
    <div className="share-targets">
      <button type="button" className="primary" onClick={() => choose("new")}>＋ 新对话</button>
      {targets.map(s => <button type="button" key={s.sessionId} onClick={() => choose(s.sessionId)}>
        <span>{title(s)}</span><small><Origin agent={s.agent} workerId={s.workerId} machineId={s.machineId}>{labels[s.status] ?? s.status}</Origin></small></button>)}
      {!targets.length && <small className="hint">最近会话里没有可发送的，可以新建对话。</small>}
    </div>
  </aside>;
}

function ActionView({ control, state }: { control: ControlState; state: ViewState }) {
  const i = state.intent, done = i?.receipt?.status === "succeeded" && !i.error, [hidden, setHidden] = useState<string>();
  // A settled action shows briefly; failures and uncertain ones stay until handled.
  useEffect(() => {
    if (!done) return; const timer = setTimeout(() => setHidden(i!.key), 2500); return () => clearTimeout(timer);
  }, [done, i?.key]);
  if (!i || done && hidden === i.key) return null;
  const label = i.submitting ? "正在提交…" : i.uncertain ? "操作结果尚未确认" : i.receipt?.status === "accepted" ? "已接收，等待 Bridge 确认…"
    : i.receipt?.status === "succeeded" ? "操作已被接受" : "操作未完成";
  const retry = !i.submitting && (i.uncertain || !i.receipt || i.receipt.status === "failed" && i.receipt.error?.error.retryable);
  return <aside className={`action-banner toast ${i.error ? "action-error" : ""}`} aria-live="polite">
    <div><strong>{label}</strong>{i.error && <p>{i.error}</p>}
      {i.receipt && <small>action · {i.receipt.actionId}</small>}
      {i.receipt?.status === "succeeded" && <p className="hint">RPC 已接受，turn 结果以会话状态为准。</p>}
    </div>
    <div className="row-actions">{retry && <button onClick={() => void control.retry()}>{i.uncertain ? "原请求重试" : "重试操作"}</button>}
      {i.receipt?.status === "accepted" && <button onClick={() => void control.checkAction()}>查询结果</button>}</div>
  </aside>;
}

/** Scroll positions by page for this tab, so switching back and forth does not lose the place. */
const scrollMemory = new Map<string, { y: number; bottom: boolean }>();
function useRememberScroll(key: string, onScroll?: (bottom: boolean) => void) {
  const callback = useRef(onScroll); callback.current = onScroll;
  // A layout effect: its cleanup still sees this page's DOM, before the next page's shorter content clamps the scroll.
  useLayoutEffect(() => {
    const save = () => {
      const bottom = window.scrollY + window.innerHeight > document.documentElement.scrollHeight - 160;
      scrollMemory.set(key, { y: window.scrollY, bottom }); return bottom;
    };
    const scroll = () => callback.current?.(save());
    window.addEventListener("scroll", scroll, { passive: true });
    return () => { window.removeEventListener("scroll", scroll); save(); };
  }, [key]);
}

function Sessions({ control, state, banners }: { control: ControlState; state: ViewState; banners: React.ReactNode }) {
  useRememberScroll("sessions");
  useLayoutEffect(() => { const saved = scrollMemory.get("sessions"); if (saved) window.scrollTo({ top: saved.y }); }, []);
  const worker = state.workers.find(w => w.id === state.workerFilter);
  return <section className="page">
    <TopBar title="最近会话" sub={state.loading ? "正在读取…" : `${state.sessions.length} 个会话${worker ? ` · ${worker.name}` : ""}`} menu={close => <>
      <button type="button" className="sheet-item" disabled={state.loading} onClick={() => { close(); void control.refresh(); }}>↻ 刷新列表</button>
      <label className="sheet-field" htmlFor="worker-filter">只看这台机器 / Agent<select id="worker-filter" value={state.workerFilter}
        onChange={e => { control.setFilters(state.query, e.target.value); close(); void control.refresh(); }}><option value="">所有机器与 Agent</option>
        {state.workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </>} />
    {banners}
    <MemoryReviewPanel writable={state.writable} />
    <ToolApprovalPanel writable={state.writable} />
    <AutomationPanel writable={state.writable} />
    <div className="session-list">{state.sessions.map(s => { const unread = s.room ? 0 : unreadCount(state, s); return <Link key={s.sessionId} to={`/control/sessions/${segment(s.sessionId)}`} className="session-row">
      <span className="machine-stripe" style={machineStyle(s.machineId)} aria-hidden="true" />
      <div className="session-row-top"><Status status={s.status} /><span className="row-end">
        {s.room && <span className="room-badge" title={`回复发在 ${s.room.connector === "matrix" ? "Matrix" : s.room.connector} 房间「${s.room.name}」`}>#{s.room.name}</span>}
        {unread > 0 && <span className="unread-badge" aria-label={`${unread} 条未读回复`}>{unread > 99 ? "99+" : unread}</span>}
        <time title="最后一条消息">{time(promptTime(s))}</time></span></div>
      <h2>{title(s)}</h2><p><Origin agent={s.agent} workerId={s.workerId} machineId={s.machineId}>{s.projectName}</Origin></p>
      {(s.pendingApprovalCount > 0 || s.pendingUserInputCount > 0) && <small className="pending-count">{s.pendingApprovalCount} 项审批 · {s.pendingUserInputCount} 项待答</small>}
      <span className="row-arrow" aria-hidden="true">↗</span>
    </Link>; })}</div>
    {state.loading && !state.sessions.length && <Skeleton rows={4} kind="session" />}
    {!state.loading && !state.sessions.length && <div className="empty">还没有匹配的会话。<p>换个关键词，或发起一段新对话。</p></div>}
    {state.hasMore && <button className="load-more" disabled={state.moreLoading || state.loading} onClick={() => void control.loadList(true)}>{state.moreLoading ? "加载中…" : "加载更多会话"}</button>}
    <p className="hint refresh-note">{time(state.updatedAt)} 更新 · <button type="button" className="quiet inline" disabled={state.loading} onClick={() => void control.refresh()}>刷新</button></p>
    <form className="dock filters" ref={dockRef} role="search" onSubmit={e => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); void control.refresh(); }}>
      <label className="sr-only" htmlFor="search">搜索会话</label><input id="search" type="search" enterKeyHint="search" placeholder="搜索标题、项目或提示词" value={state.query}
        onChange={e => control.setFilters(e.target.value, state.workerFilter)} />
      {state.writable && <Link className="button primary new-button" to="/control/new">＋ 新对话</Link>}
    </form>
  </section>;
}

function NewSession({ control, state, banners }: { control: ControlState; state: ViewState; banners: React.ReactNode }) {
  const [workerId, setWorkerId] = useState(""), [workspace, setWorkspace] = useState("");
  const input = state.drafts.new ?? "", [model, setModel] = useState<ModelChoice>({ model: "", effort: "" });
  const choices = state.workers.filter(w => w.status === "online" && w.capabilities.includes("session-actions"));
  const worker = choices.find(w => w.id === workerId);
  const allSpaces = (worker?.workspaces ?? []).map(path => ({ name: path, path }));
  const quickSpaces = worker?.recentWorkspaces?.length ? worker.recentWorkspaces : allSpaces.slice(0, 8);
  const busy = isBusy(state) || uploading(state, "new");
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(workspace);
  return <section className="page"><TopBar back="/control/sessions" title="新的对话" />
    {banners}
    <form className="panel new-form" onSubmit={e => {
      e.preventDefault(); if (!worker || !absolute || busy || !state.writable) return;
      haptic("tick");
      void control.submit("/sessions", { workerId, workspace, ...modelBody(model),
        ...(input.trim() ? { input, ...attachmentBody(state, "new") } : {}) }, "new");
    }}>
      <label htmlFor="new-worker">由谁来执行</label><select id="new-worker" value={workerId} required onChange={e => { setWorkerId(e.target.value); setWorkspace(""); setModel({ model: "", effort: "" }); }}>
        <option value="">选择在线 Worker</option>{choices.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      {worker && <small><Origin workerId={worker.id} machineId={worker.id.slice(worker.id.indexOf("@") + 1)}>{worker.name}</Origin></small>}
      {!choices.length && <p className="hint">没有在线且支持会话操作的 Worker，请刷新后重试。</p>}
      <label htmlFor="workspace">工作目录</label><input id="workspace" list="recent-spaces" value={workspace} required
        onChange={e => setWorkspace(e.target.value)} placeholder="选择最近目录，或输入目标机器绝对路径" autoCapitalize="none" spellCheck={false} />
      <datalist id="recent-spaces">{allSpaces.map(s => <option key={s.path} value={s.path}>{s.name}</option>)}</datalist>
      {worker && quickSpaces.length > 0 && <div className="workspace-choices">{quickSpaces.slice(0, 6).map(s => <button type="button" key={s.path} onClick={() => setWorkspace(s.path)}>{s.name}</button>)}</div>}
      {workspace && !absolute && <p className="hint">请使用目标机器上的绝对路径。</p>}
      <label htmlFor="first-message">第一条消息 <span className="muted">（可选）</span></label><textarea id="first-message" rows={6} value={input} onChange={e => control.setDraft("new", e.target.value)} onPaste={pasteImages(control, "new")} onKeyDown={submitWithKeyboard} aria-keyshortcuts="Control+Enter Meta+Enter" placeholder="想让 Agent 做什么？" />
      <AttachmentList control={control} state={state} id="new" />
      <div><AttachButton control={control} id="new" disabled={!state.writable} /></div>
      {(state.uploads.new?.length ?? 0) > 0 && !input.trim() && <p className="hint">图片需随第一条消息发送。</p>}
      <ModelPicker control={control} state={state} workerId={worker?.id} value={model} onChange={setModel} />
      <p className="hint">未选择时沿用 Agent 默认模型和思考程度。路径由目标 Bridge 校验。</p>
      <div className="dock form-dock" ref={dockRef}><button type="submit" className="primary" disabled={!state.writable || !worker || !absolute || busy}>{busy ? "正在创建…" : "创建对话 →"}</button></div>
    </form></section>;
}

const RUNNING_TOOL = new Set(["tool.started", "task.started", "task.progress"]);
/** One line per tool call: its first line, shown in place of the call's earlier events. */
function ToolLine({ event: shown, expanded = false, load }: { event: SessionEvent; expanded?: boolean; load?: () => Promise<SessionEvent> }) {
  const [open, setOpen] = useState(false), [whole, setWhole] = useState<SessionEvent | "loading" | "error">();
  const event = typeof whole === "object" ? whole : shown;
  const p = event.payload;
  const text = String(typeof p.command === "string" ? `$ ${p.command}` : p.summary ?? p.description ?? p.name ?? event.type).trim().split("\n")[0] || event.type;
  const running = RUNNING_TOOL.has(event.type);
  const failed = ["failed", "declined", "error"].includes(String(p.status)) || typeof p.exitCode === "number" && p.exitCode !== 0;
  const kind = typeof p.command === "string" ? "command" : event.type.startsWith("file_change") ? "file" : event.type.startsWith("task") ? "task" : "tool";
  return <details open={expanded || open} className={`tool ${running ? "running" : ""} ${failed ? "failed" : ""}`} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary><span className="tool-mark" aria-hidden="true">{{ command: "$", file: "✎", task: "◇", tool: "›" }[kind]}</span>
      <span className="tool-text">{text.replace(/^\$ /, "")}</span>{failed && <span className="tool-flag">失败</span>}</summary>
    {(expanded || open) && <>{load && typeof whole !== "object" && <button type="button" className="quiet" disabled={whole === "loading"}
      onClick={() => { setWhole("loading"); load().then(setWhole, () => setWhole("error")); }}>
      {whole === "loading" ? "读取中…" : whole === "error" ? "读取失败，重试" : "内容已截断 · 加载完整内容"}</button>}
      <pre>{JSON.stringify(p, null, 2)}</pre></>}</details>;
}

function EventView({ event, expanded = false, load }: { event: SessionEvent; expanded?: boolean; load?: () => Promise<SessionEvent> }) {
  const p = event.payload;
  if (event.type === "message.completed") return <article className={`message ${p.role === "user" ? "user" : "assistant"}`}>
    <div className="message-label">{p.role === "user" ? "你" : p.role === "assistant" ? "AGENT" : "SYSTEM"}<time>{time(event.timestamp)}</time></div>
    {typeof p.text === "string" ? <MessageText text={p.text} markdown={p.role !== "user"} /> : <div className="message-text">（无文本消息）</div>}
  </article>;
  if (TOOL_TYPES.has(event.type)) return <ToolLine event={event} expanded={expanded} load={load} />;
  if (event.type === "progress") return <p className="progress-note">{String(p.summary ?? "正在思考…")}</p>;
  const label: Record<string, string> = { "turn.started": "开始执行", "turn.completed": "本轮完成", "turn.failed": "本轮失败", "turn.interrupted": "本轮已打断",
    "approval.requested": "请求审批", "approval.resolved": "审批已处理", "user_input.requested": "等待回答", "user_input.resolved": "问题已回答", error: "执行异常" };
  return label[event.type] ? <div className="event-note"><span>{label[event.type]}</span>{Boolean(p.error || p.summary && event.type !== "turn.completed") && <p>{String(p.error ?? p.summary)}</p>}</div> : null;
}

function Skeleton({ rows, kind }: { rows: number; kind: "session" | "message" }) {
  return <div className="skeleton" role="status" aria-label="正在加载">{Array.from({ length: rows }, (_, i) =>
    <div key={i} className={`skeleton-${kind} ${kind === "message" && i % 2 === 0 ? "user" : ""}`}><span /><span /><span /></div>)}</div>;
}

function Detail({ control, state, id, banners }: { control: ControlState; state: ViewState; id: string; banners: React.ReactNode }) {
  const session = state.session?.sessionId === id ? state.session : undefined;
  const worker = state.workers.find(w => w.id === session?.workerId);
  const caps = session?.capabilities ?? worker?.capabilities ?? [];
  const online = worker?.status === "online" && session?.status !== "offline";
  const busy = isBusy(state);
  const canOperate = state.writable && online && caps.includes("session-actions") && !state.loading && !state.syncing && !busy;
  const blocked = Boolean(session && (session.pendingApprovalCount || session.pendingUserInputCount || session.status.startsWith("waiting")));
  const running = isLive(session);
  const canInterrupt = Boolean(session && canOperate && session.activeTurnId && running && caps.includes("turn-interrupt"));
  const interrupt = () => void control.submit(`/sessions/${segment(id)}/interrupt`, { expectedTurnId: session!.activeTurnId });
  const draft = state.drafts[id] ?? "", [model, setModel] = useState<ModelChoice>({ model: "", effort: "" });
  const [optionsOpen, setOptionsOpen] = useState(false), canResolve = state.writable && online && !state.syncing && !busy;
  const bottom = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null), pendingPanel = useRef<HTMLElement>(null);
  const message = useRef<HTMLTextAreaElement>(null);
  // The composer grows with its text, up to the stylesheet's max-height, then scrolls.
  useLayoutEffect(() => {
    const el = message.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft, session !== undefined]);
  const restore = useRef(scrollMemory.get(id));
  const follow = useRef(restore.current?.bottom ?? true), [unread, setUnread] = useState(0), previous = useRef(state.rawAdded);
  const anchor = useRef<{ top: number; height: number }>();
  const turns = state.entries;
  const [detailMode, setDetailMode] = useState<DetailMode>(() => {
    try { const saved = localStorage.getItem('bridge-transcript-mode'); return saved && saved in DETAIL_MODES ? saved as DetailMode : 'standard'; }
    catch { return 'standard'; }
  });
  useEffect(() => { if (!state.moreLoading) anchor.current = undefined; }, [state.moreLoading]);
  useRememberScroll(id, bottom => { follow.current = bottom; if (bottom) setUnread(0); });
  useLayoutEffect(() => {
    if (restore.current && turns.length) {
      // A revisited conversation reopens where it was left (or at its end, when it was followed).
      if (restore.current.bottom) bottom.current?.scrollIntoView({ block: "end" }); else window.scrollTo({ top: restore.current.y });
      restore.current = undefined;
    } else if (anchor.current) {
      window.scrollTo({ top: anchor.current.top + (transcript.current?.scrollHeight ?? 0) - anchor.current.height });
      anchor.current = undefined;
    } else if (turns.length) {
      // New events recorded while scrolled up; view revisions of what is already shown do not count.
      const count = Math.max(0, state.rawAdded - previous.current);
      if (follow.current) bottom.current?.scrollIntoView({ block: "end" });
      else setUnread(v => v + count);
    }
    previous.current = state.rawAdded;
  }, [turns, state.rawAdded]);
  const setMode = (mode: DetailMode) => { setDetailMode(mode); try { localStorage.setItem('bridge-transcript-mode', mode); } catch { /* optional preference */ } };
  const pendingCount = state.approvals.length + state.inputs.length;
  return <section className="page detail-page">
    <TopBar back="/control/sessions" title={session ? title(session) : state.loading ? "正在读取会话…" : "会话详情"}
      sub={session && <><Status status={session.status} /><span aria-live="polite">{state.syncing ? "正在同步…" : state.connection}</span></>}
      menu={close => session && <>
        <div className="sheet-info" style={machineStyle(session.machineId)}>
          <Origin agent={session.agent} workerId={session.workerId} machineId={session.machineId}>{session.projectName}</Origin>
          <p className="break-all">{session.workspace}</p><small className="break-all">Session · {id}</small>
          <small>历史覆盖：{session.historyCompleteness ?? "未知"} · {session.source ?? "未知来源"}</small></div>
        <label className="sheet-field" htmlFor="transcript-mode">过程显示<select id="transcript-mode" value={detailMode}
          onChange={e => { setMode(e.target.value as DetailMode); close(); }}>
          {Object.entries(DETAIL_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="sheet-item" disabled={state.loading} onClick={() => { close(); void control.refresh(); }}>↻ 刷新会话</button>
      </>} />
    {banners}
    {session?.error && <p className="error">{session.error.error.message}</p>}
    <div className="transcript" ref={transcript}>
      {state.historyMore && <button className="load-more" disabled={state.moreLoading} onClick={() => {
        anchor.current = { top: window.scrollY, height: transcript.current?.scrollHeight ?? 0 }; void control.moreHistory();
      }}>{state.moreLoading ? "读取中…" : "↑ 加载更早内容"}</button>}
      {state.loading && !turns.length && <Skeleton rows={3} kind="message" />}
      {turns.map(entry => <TurnView key={`${entry.key}:${detailMode}`} entry={entry} session={session} mode={detailMode}
        onMoreItems={(key, before) => void control.moreItems(key, before)}
        render={(item, expanded) => <EventView event={item.event} expanded={expanded}
          load={item.truncated ? () => control.fullEvent(item.event.eventId) : undefined} />} />)}
      {!state.loading && !turns.length && <div className="empty">还没有已记录的内容。</div>}
      {state.syncing ? <p className="sync-note" role="status"><span className="spinner" aria-hidden="true" />正在加载最新消息…</p>
        : session?.status === "active" && <p className="sync-note working" role="status"><AgentIcon agent={session.agent} workerId={session.workerId} size={14} />正在工作<span className="dots" aria-hidden="true"><i /><i /><i /></span></p>}
      {/* At the end of the transcript, beside the composer the page follows, not above the history. */}
      {session?.trusted && <p className="sync-note" role="status">本会话已全部允许，它的操作不再问你。
        <button type="button" className="quiet" disabled={!state.writable} onClick={() => { haptic("tick"); void control.untrust(id); }}>撤销</button></p>}
      {session && (pendingCount > 0 || blocked) && <aside className="pending-panel" ref={pendingPanel}><strong>等待你处理</strong>
        {state.approvals.map(p => <ApprovalCard key={pendingId(p)} control={control} pending={p} disabled={!canResolve} />)}
        {state.inputs.map(p => <InputCard key={pendingId(p)} control={control} state={state} pending={p} disabled={!canResolve} />)}
        {!state.approvals.length && !state.inputs.length && <small>正在读取待办…</small>}
        {!canResolve && <small>{!state.writable ? "只读模式，无法处理。" : !online ? "Worker 离线，暂不能处理。" : state.syncing ? "正在同步…" : "正在提交…"}</small>}</aside>}
      <div ref={bottom} className="transcript-end" />
    </div>
    {unread > 0 && <button className="new-content" onClick={() => { follow.current = true; setUnread(0); bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }}>↓ {unread} 条新内容</button>}
    {session && <form className="composer dock" ref={dockRef} onSubmit={e => {
      e.preventDefault(); if (!canOperate || !draft.trim() || blocked) return;
      if (uploading(state, id)) return;
      haptic("tick");
      // Running without a known turn id (some agents report "running" alone): the server decides steer or new turn.
      const body = session.activeTurnId ? { input: draft, delivery: "steer", expectedTurnId: session.activeTurnId, ...attachmentBody(state, id) }
        : running ? { input: draft, delivery: "auto", ...attachmentBody(state, id) }
        : { input: draft, delivery: "start_turn", ...modelBody(model), ...attachmentBody(state, id) };
      void control.submit(`/sessions/${segment(id)}/turns`, body, id);
    }}>
      {pendingCount > 0 && <button type="button" className="pending-strip" onClick={() => pendingPanel.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
        <span className="dot" aria-hidden="true" />{[state.approvals.length && `${state.approvals.length} 项审批`, state.inputs.length && `${state.inputs.length} 个问题`].filter(Boolean).join(" · ")}等你处理<span>查看 ↓</span></button>}
      <AttachmentList control={control} state={state} id={id} />
      {!running && <details className="composer-options" onToggle={e => setOptionsOpen(e.currentTarget.open)}><summary>模型 {model.model ? state.models[session.workerId]?.models.find(m => m.model === model.model)?.displayName ?? model.model : "默认"} · 思考 {model.effort ? effortLabels[model.effort] ?? model.effort : "默认"}</summary>
        {optionsOpen && <ModelPicker control={control} state={state} workerId={session.workerId} value={model} onChange={setModel} />}</details>}
      <div className="composer-row">
        <AttachButton control={control} id={id} disabled={!state.writable} compact />
        <label className="sr-only" htmlFor="message">发送消息</label>
        <textarea id="message" ref={message} rows={1} value={draft} onChange={e => control.setDraft(id, e.target.value)} onPaste={pasteImages(control, id)} onKeyDown={submitWithKeyboard} aria-keyshortcuts="Control+Enter Meta+Enter" title="Enter 换行 · Ctrl / ⌘ + Enter 发送" placeholder={blocked ? "请先处理审批或问题" : running ? "追加指令…" : "继续这段对话…"} />
        {running && <button type="button" className="interrupt icon-button" aria-label="中断当前回合" title="中断" disabled={!canInterrupt} onClick={interrupt}>■</button>}
        <button type="submit" className="primary send" disabled={!canOperate || !draft.trim() || blocked || uploading(state, id) || Boolean(running && session.activeTurnId && !caps.includes("turn-steer")) || !["idle", "active"].includes(session.status)}>{running ? "追加" : "发送"}</button>
      </div>
      {Boolean(!state.writable ? "只读模式" : blocked ? (pendingCount ? "" : "等待处理待办") : !online ? "Worker 离线" : uploading(state, id) ? "图片上传中…" : "") && <small className="composer-reason">{!state.writable ? "只读模式" : blocked ? (pendingCount ? "" : "等待处理待办") : !online ? "Worker 离线" : uploading(state, id) ? "图片上传中…" : ""}</small>}
    </form>}
  </section>;
}

createRoot(document.getElementById("root")!).render(<App />);
// Installability only: the worker caches nothing (see public/sw.js). Not under the vite dev server.
if ("serviceWorker" in navigator && BUILD_VERSION !== "dev") void navigator.serviceWorker.register("/control/sw.js", { scope: "/control/" }).catch(() => {});
