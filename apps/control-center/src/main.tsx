import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

function Attachments({ control, state, id, disabled }: { control: ControlState; state: ViewState; id: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null), rows = state.uploads[id] ?? [];
  return <div className="attachments">
    {rows.length > 0 && <ul className="attachment-list">{rows.map(u => <li key={u.localId} className={`attachment ${u.status}`}>
      {u.preview ? <img src={u.preview} alt="" /> : <span className="attachment-thumb" aria-hidden="true">文件</span>}<span>{u.status === "uploading" ? "上传中…" : u.status === "error" ? u.error : u.name}</span>
      <button type="button" className="quiet" aria-label={`移除 ${u.name}`} onClick={() => control.removeUpload(id, u.localId)}>×</button></li>)}</ul>}
    <input ref={input} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx" multiple hidden onChange={e => {
      control.addFiles(id, [...(e.target.files ?? [])]); e.target.value = "";
    }} />
    <button type="button" className="quiet attach" disabled={disabled} onClick={() => input.current?.click()}>＋ 图片 / 文件</button>
  </div>;
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
const choiceLabels: Record<string, string> = { allow: "允许", deny: "拒绝", "allow-session": "本会话始终允许", "allow-always": "永久允许" };
function ApprovalCard({ control, pending, disabled }: { control: ControlState; pending: Pending; disabled: boolean }) {
  const id = pendingId(pending), choices = pending.choices?.length ? pending.choices : ["allow", "deny"];
  return <div className="pending-item"><div className="pending-kind">审批{pending.kind ? ` · ${pending.kind}` : ""}</div>
    <pre className="pending-summary">{pending.summary ?? "（无摘要）"}</pre>
    <div className="row-actions">{choices.map(choice => <button key={choice} type="button" disabled={disabled}
      className={choice === "allow" ? "primary" : choice === "deny" ? "danger" : ""}
      onClick={() => {
        haptic("tick");
        void control.submit(`/approvals/${segment(id)}/decision`, { choice });
      }}>{choiceLabels[choice] ?? choice}</button>)}</div>
    {choices.includes("allow-session") && <small className="hint">“本会话始终允许”放行这个工具在本会话的后续调用；{choices.includes("allow-always") ? "“永久允许”对这台机器之后的所有会话都放行（写入 Claude 的 settings.json）。" : "不只当前这一条。"}</small>}
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
      <pre className="pending-summary">{r.summary}</pre>
      {r.reason && <p className="hint">审核：{r.reason}</p>}
      <details><summary>完整内容</summary><pre className="pending-summary">{JSON.stringify(r.args, null, 2)}</pre></details>
      {writable && <div className="row-actions">
        <button type="button" className="primary" disabled={busy === r.id} onClick={() => void decide(r.id, "allow")}>允许写入</button>
        <button type="button" className="danger" disabled={busy === r.id} onClick={() => void decide(r.id, "deny")}>拒绝</button></div>}
    </div>)}
  </aside>;
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
        if (!/^\/control\/(sessions(?:\/[^/]+)?|new)\/?$/.test(location.pathname)) navigate("/control/sessions");
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
  const match = path.match(/^\/control\/sessions\/([^/]+)\/?$/);
  try { route = match ? { page: "detail", id: decodeURIComponent(match[1]) } : { page: path === "/control/new" ? "new" : "sessions" }; }
  catch { route = { page: "sessions" }; }
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
  return <div className="shell">
    <header className="topbar"><Link to="/control/sessions" className="brand"><span className="brand-mark">ab</span><span>控制中心</span></Link>
      <div className="top-actions"><span className="scope">{state.writable ? "操作模式" : "只读模式"}</span></div>
    </header>
    {(state.loading || state.syncing) && <div className="loading-bar" role="progressbar" aria-label="正在加载" />}
    <main>
      {stale && <aside className="action-banner" role="status"><strong>控制中心已更新</strong>
        <p>这个页面还是旧版本，刷新后才能使用新功能（如处理审批）。</p>
        <div className="row-actions"><button className="primary" onClick={() => location.reload()}>立即刷新</button></div></aside>}
      {state.error && <div className="error" role="alert">{state.error}<button className="quiet" onClick={() => void control.refresh()}>刷新</button></div>}
      <ActionView control={control} state={state} />
      {state.share && <SharePicker control={control} state={state} />}
      {route.page === "sessions" ? <Sessions control={control} state={state} />
        : route.page === "new" ? <NewSession control={control} state={state} />
          : <Detail key={route.id} control={control} state={state} id={route.id!} />}
    </main>
    <footer>AGENT BRIDGE <span>·</span> 页面 v{BUILD_VERSION} <span>·</span> 服务 v{serverVersion}
      {stale && <button className="quiet" onClick={() => location.reload()}>页面不是最新，刷新</button>}</footer>
  </div>;
}

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
  const i = state.intent; if (!i) return null;
  const label = i.submitting ? "正在提交…" : i.uncertain ? "操作结果尚未确认" : i.receipt?.status === "accepted" ? "已接收，等待 Bridge 确认…"
    : i.receipt?.status === "succeeded" ? "操作已被接受" : "操作未完成";
  const retry = !i.submitting && (i.uncertain || !i.receipt || i.receipt.status === "failed" && i.receipt.error?.error.retryable);
  return <aside className={`action-banner ${i.error ? "action-error" : ""}`} aria-live="polite">
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

function Sessions({ control, state }: { control: ControlState; state: ViewState }) {
  useRememberScroll("sessions");
  useLayoutEffect(() => { const saved = scrollMemory.get("sessions"); if (saved) window.scrollTo({ top: saved.y }); }, []);
  return <section>
    <MemoryReviewPanel writable={state.writable} />
    <div className="page-heading"><div><div className="eyebrow">YOUR CONVERSATIONS</div><h1>最近会话</h1></div>
      {state.writable && <Link className="button primary" to="/control/new">＋ 新对话</Link>}</div>
    <form className="filters" onSubmit={e => { e.preventDefault(); void control.refresh(); }}>
      <label className="sr-only" htmlFor="search">搜索会话</label><input id="search" type="search" placeholder="搜索标题、项目或提示词" value={state.query}
        onChange={e => control.setFilters(e.target.value, state.workerFilter)} />
      <label className="sr-only" htmlFor="worker-filter">按 worker 筛选</label><select id="worker-filter" value={state.workerFilter}
        onChange={e => control.setFilters(state.query, e.target.value)}><option value="">所有机器与 Agent</option>
        {state.workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      <button disabled={state.loading}>搜索</button>
    </form>
    <div className="list-meta"><span>{state.loading ? "正在读取…" : `${state.sessions.length} 个会话`}</span>
      <button className="quiet" disabled={state.loading} onClick={() => void control.refresh()}>↻ 刷新</button></div>
    <div className="session-list">{state.sessions.map(s => { const unread = unreadCount(state, s); return <Link key={s.sessionId} to={`/control/sessions/${segment(s.sessionId)}`} className="session-row">
      <span className="machine-stripe" style={machineStyle(s.machineId)} aria-hidden="true" />
      <div className="session-row-top"><Status status={s.status} /><span className="row-end">
        {unread > 0 && <span className="unread-badge" aria-label={`${unread} 条未读回复`}>{unread > 99 ? "99+" : unread}</span>}
        <time title="最后一条消息">{time(promptTime(s))}</time></span></div>
      <h2>{title(s)}</h2><p><Origin agent={s.agent} workerId={s.workerId} machineId={s.machineId}>{s.projectName}</Origin></p>
      {(s.pendingApprovalCount > 0 || s.pendingUserInputCount > 0) && <small className="pending-count">{s.pendingApprovalCount} 项审批 · {s.pendingUserInputCount} 项待答</small>}
      <span className="row-arrow" aria-hidden="true">↗</span>
    </Link>; })}</div>
    {state.loading && !state.sessions.length && <Skeleton rows={4} kind="session" />}
    {!state.loading && !state.sessions.length && <div className="empty">还没有匹配的会话。<p>换个关键词，或发起一段新对话。</p></div>}
    {state.hasMore && <button className="load-more" disabled={state.moreLoading || state.loading} onClick={() => void control.loadList(true)}>{state.moreLoading ? "加载中…" : "加载更多会话"}</button>}
    <p className="hint refresh-note">按需刷新 · {time(state.updatedAt)} 更新</p>
  </section>;
}

function NewSession({ control, state }: { control: ControlState; state: ViewState }) {
  const [workerId, setWorkerId] = useState(""), [workspace, setWorkspace] = useState("");
  const input = state.drafts.new ?? "", [model, setModel] = useState<ModelChoice>({ model: "", effort: "" });
  const choices = state.workers.filter(w => w.status === "online" && w.capabilities.includes("session-actions"));
  const worker = choices.find(w => w.id === workerId);
  const spaces = worker?.recentWorkspaces?.length ? worker.recentWorkspaces : (worker?.workspaces ?? []).map(path => ({ name: path, path }));
  const busy = isBusy(state) || uploading(state, "new");
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(workspace);
  return <section><Link className="back" to="/control/sessions">← 最近会话</Link>
    <div className="page-heading"><div><div className="eyebrow">START SOMETHING</div><h1>新的对话</h1></div></div>
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
      <datalist id="recent-spaces">{spaces.map(s => <option key={s.path} value={s.path}>{s.name}</option>)}</datalist>
      {worker && spaces.length > 0 && <div className="workspace-choices">{spaces.slice(0, 6).map(s => <button type="button" key={s.path} onClick={() => setWorkspace(s.path)}>{s.name}</button>)}</div>}
      {workspace && !absolute && <p className="hint">请使用目标机器上的绝对路径。</p>}
      <label htmlFor="first-message">第一条消息 <span className="muted">（可选）</span></label><textarea id="first-message" rows={6} value={input} onChange={e => control.setDraft("new", e.target.value)} onPaste={pasteImages(control, "new")} onKeyDown={submitWithKeyboard} aria-keyshortcuts="Control+Enter Meta+Enter" placeholder="想让 Agent 做什么？" />
      <Attachments control={control} state={state} id="new" disabled={!state.writable} />
      {(state.uploads.new?.length ?? 0) > 0 && !input.trim() && <p className="hint">图片需随第一条消息发送。</p>}
      <ModelPicker control={control} state={state} workerId={worker?.id} value={model} onChange={setModel} />
      <p className="hint">未选择时沿用 Agent 默认模型和思考程度。路径由目标 Bridge 校验。</p>
      <p className="hint">Enter 换行 · Ctrl / ⌘ + Enter 创建对话</p>
      <button type="submit" className="primary" disabled={!state.writable || !worker || !absolute || busy}>{busy ? "正在创建…" : "创建对话 →"}</button>
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

function Detail({ control, state, id }: { control: ControlState; state: ViewState; id: string }) {
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
  const bottom = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null);
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
  return <section className="detail-page"><Link className="back" to="/control/sessions">← 最近会话</Link>
    <div className="detail-heading"><div className="eyebrow">CONVERSATION</div><h1>{session ? title(session) : state.loading ? "正在读取会话…" : "会话详情"}</h1></div>
    {session && <>
      <div className="detail-status"><div><Status status={session.status} /><small aria-live="polite">{state.syncing ? "正在同步…" : state.connection}</small></div>
        <button className="interrupt" disabled={!canInterrupt} onClick={interrupt}>■ 打断</button></div>
      <details className="session-info" style={machineStyle(session.machineId)}><summary><Origin agent={session.agent} workerId={session.workerId} machineId={session.machineId}>{session.projectName}</Origin></summary>
        <p className="break-all">{session.workspace}</p><small className="break-all">Session · {id}</small>
        <p className="hint">历史覆盖：{session.historyCompleteness ?? "未知"} · {session.source ?? "未知来源"}</p></details>
      <div className="detail-tools"><label className="transcript-mode">过程显示 <select aria-label="过程显示" value={detailMode} onChange={e => {
        const mode = e.target.value as DetailMode; setDetailMode(mode); try { localStorage.setItem('bridge-transcript-mode', mode); } catch { /* optional preference */ }
      }}>{Object.entries(DETAIL_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="quiet" disabled={state.loading} onClick={() => void control.refresh()}>↻ 刷新</button></div>
      {session.error && <p className="error">{session.error.error.message}</p>}
    </>}
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
      {session && (state.approvals.length > 0 || state.inputs.length > 0 || blocked) && <aside className="pending-panel"><strong>等待你处理</strong>
        {state.approvals.map(p => <ApprovalCard key={pendingId(p)} control={control} pending={p} disabled={!canResolve} />)}
        {state.inputs.map(p => <InputCard key={pendingId(p)} control={control} state={state} pending={p} disabled={!canResolve} />)}
        {!state.approvals.length && !state.inputs.length && <small>正在读取待办…</small>}
        {!canResolve && <small>{!state.writable ? "只读模式，无法处理。" : !online ? "Worker 离线，暂不能处理。" : state.syncing ? "正在同步…" : "正在提交…"}</small>}</aside>}
      <div ref={bottom} className="transcript-end" />
    </div>
    {unread > 0 && <button className="new-content" onClick={() => { follow.current = true; setUnread(0); bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }}>↓ {unread} 条新内容</button>}
    {session && <form className="composer" onSubmit={e => {
      e.preventDefault(); if (!canOperate || !draft.trim() || blocked) return;
      if (uploading(state, id)) return;
      haptic("tick");
      // Running without a known turn id (some agents report "running" alone): the server decides steer or new turn.
      const body = session.activeTurnId ? { input: draft, delivery: "steer", expectedTurnId: session.activeTurnId, ...attachmentBody(state, id) }
        : running ? { input: draft, delivery: "auto", ...attachmentBody(state, id) }
        : { input: draft, delivery: "start_turn", ...modelBody(model), ...attachmentBody(state, id) };
      void control.submit(`/sessions/${segment(id)}/turns`, body, id);
    }}><label className="sr-only" htmlFor="message">发送消息</label>
      <textarea id="message" rows={3} value={draft} onChange={e => control.setDraft(id, e.target.value)} onPaste={pasteImages(control, id)} onKeyDown={submitWithKeyboard} aria-keyshortcuts="Control+Enter Meta+Enter" placeholder={blocked ? "请先处理审批或问题" : running ? "追加指令…" : "继续这段对话…"} />
      <Attachments control={control} state={state} id={id} disabled={!state.writable} />
      {!running && <details className="composer-options" onToggle={e => setOptionsOpen(e.currentTarget.open)}><summary>模型 {model.model ? state.models[session.workerId]?.models.find(m => m.model === model.model)?.displayName ?? model.model : "默认"} ·思考 {model.effort ? effortLabels[model.effort] ?? model.effort : "默认"}</summary>
        {optionsOpen && <ModelPicker control={control} state={state} workerId={session.workerId} value={model} onChange={setModel} />}</details>}
      <div className="composer-actions"><small>{!state.writable ? "只读模式" : blocked ? "等待处理待办" : !online ? "Worker 离线" : uploading(state, id) ? "图片上传中…" : "Enter 换行 · Ctrl / ⌘ + Enter 发送"}</small>
        <div className="row-actions">{running && <button type="button" className="danger" disabled={!canInterrupt} onClick={interrupt}>■ 中断</button>}
        <button type="submit" className="primary" disabled={!canOperate || !draft.trim() || blocked || uploading(state, id) || Boolean(running && session.activeTurnId && !caps.includes("turn-steer")) || !["idle", "active"].includes(session.status)}>{running ? "追加指令 ↑" : "发送 ↑"}</button></div></div>
    </form>}
  </section>;
}

createRoot(document.getElementById("root")!).render(<App />);
// Installability only: the worker caches nothing (see public/sw.js). Not under the vite dev server.
if ("serviceWorker" in navigator && BUILD_VERSION !== "dev") void navigator.serviceWorker.register("/control/sw.js", { scope: "/control/" }).catch(() => {});
