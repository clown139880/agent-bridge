import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ControlClient, explain } from "./api/client";
import { isLive, segment, type Session, type SessionEvent, type Snapshot } from "./api/types";
import { ControlState, type Route, type ViewState } from "./state";
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
const time = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
function Status({ status }: { status: string }) {
  return <span className={`status ${["active", "creating"].includes(status) ? "live" : status.startsWith("waiting") ? "waiting" : ""}`}>
    <span aria-hidden="true" className="dot" />{labels[status] ?? "未知状态"}</span>;
}

function App() {
  const [path, setPath] = useState(location.pathname);
  const [control, setControl] = useState<ControlState>();
  const [notice, setNotice] = useState("");
  const active = useRef<ControlState>();
  function logout(message = "") {
    active.current?.dispose(); active.current = undefined; setControl(undefined); setNotice(message);
    history.replaceState(null, "", "/control/login"); setPath("/control/login");
  }
  useEffect(() => {
    const change = () => setPath(location.pathname);
    window.addEventListener("popstate", change);
    return () => { window.removeEventListener("popstate", change); active.current?.dispose(); };
  }, []);
  if (!control) return <Login notice={notice} onLogin={(token, writable, snapshot) => {
    const instance = new ControlState(token, writable, snapshot, () => logout("凭据已失效，请重新登录"), navigate);
    active.current = instance; setControl(instance); setNotice("");
    if (!/^\/control\/(sessions(?:\/[^/]+)?|new)\/?$/.test(path)) navigate("/control/sessions");
  }} />;
  return <Center control={control} path={path} logout={() => logout()} />;
}

function Login({ onLogin, notice }: { onLogin: (token: string, writable: boolean, snapshot: Snapshot) => void; notice: string }) {
  const [token, setToken] = useState(""), [writable, setWritable] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<ControlClient>();
  useEffect(() => () => pending.current?.dispose(), []);
  // Optional convenience: prefill the token from a URL fragment (#token=..[&write=1])
  // and immediately scrub it from the address bar and history. The fragment is client-side
  // only — it is never sent to the server or logged there.
  useEffect(() => {
    const m = location.hash.match(/^#token=([^&]*)(&write=1)?/);
    if (!m || m[1] === undefined) return;
    let t = "";
    try { t = decodeURIComponent(m[1]); } catch { return; }
    if (!t) return;
    setToken(t);
    if (m[2]) setWritable(true);
    history.replaceState(null, "", location.pathname + location.search);
  }, []);
  return <main className="login-shell">
    <div className="brand"><span className="brand-mark">ab</span><span>AGENT BRIDGE</span></div>
    <div className="eyebrow">CONTROL CENTER</div><h1>随时，接上对话。</h1>
    <p className="muted intro">查看会话进展，继续交谈，<br />把正在发生的事握在手里。</p>
    <form className="panel login-form" onSubmit={async e => {
      e.preventDefault(); if (busy || !token.trim()) return;
      setBusy(true); setError("");
      const client = new ControlClient(token.trim(), () => {}); pending.current = client;
      try {
        const snapshot = await client.request<Snapshot>("/snapshot?sessionLimit=50");
        const secret = token.trim(); setToken(""); onLogin(secret, writable, snapshot);
      } catch (e) { setError(explain(e)); }
      finally { client.dispose(); pending.current = undefined; setBusy(false); }
    }}>
      <label htmlFor="token">Control token</label>
      <input id="token" type="password" value={token} onChange={e => setToken(e.target.value)}
        autoComplete="off" autoCapitalize="none" spellCheck={false} required placeholder="粘贴 read 或 write token" />
      <label className="checkbox"><input type="checkbox" checked={writable} onChange={e => setWritable(e.target.checked)} />启用发送、新建和打断</label>
      <p className="hint">操作需 write token，最终权限由服务器验证。</p>
      {(error || notice) && <div role="alert" className="error">{error || notice}</div>}
      <button className="primary" disabled={busy || !token.trim()}>{busy ? "正在连接…" : "进入控制中心 →"}</button>
    </form>
    <p className="hint login-note">凭据只保存在当前页面内存。<br />刷新页面或关闭后，需要重新登录。</p>
  </main>;
}

function Center({ control, path, logout }: { control: ControlState; path: string; logout: () => void }) {
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  let route: Route;
  const match = path.match(/^\/control\/sessions\/([^/]+)\/?$/);
  try { route = match ? { page: "detail", id: decodeURIComponent(match[1]) } : { page: path === "/control/new" ? "new" : "sessions" }; }
  catch { route = { page: "sessions" }; }
  useEffect(() => { void control.open(route); }, [control, path]);
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
  return <div className="shell">
    <header className="topbar"><Link to="/control/sessions" className="brand"><span className="brand-mark">ab</span><span>控制中心</span></Link>
      <div className="top-actions"><span className="scope">{state.writable ? "操作模式" : "只读模式"}</span><button className="quiet" onClick={logout}>退出</button></div>
    </header>
    <main>
      {state.error && <div className="error" role="alert">{state.error}<button className="quiet" onClick={() => void control.refresh()}>刷新</button></div>}
      <ActionView control={control} state={state} />
      {route.page === "sessions" ? <Sessions control={control} state={state} />
        : route.page === "new" ? <NewSession control={control} state={state} />
          : <Detail key={route.id} control={control} state={state} id={route.id!} />}
    </main>
    <footer>AGENT BRIDGE <span>·</span> 当前页面内存登录</footer>
  </div>;
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

function Sessions({ control, state }: { control: ControlState; state: ViewState }) {
  return <section>
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
    <div className="session-list">{state.sessions.map(s => <Link key={s.sessionId} to={`/control/sessions/${segment(s.sessionId)}`} className="session-row">
      <div className="session-row-top"><Status status={s.status} /><time>{time(s.updatedAt)}</time></div>
      <h2>{title(s)}</h2><p>{s.agent} <span>·</span> {s.machineId} <span>·</span> {s.projectName}</p>
      {(s.pendingApprovalCount > 0 || s.pendingUserInputCount > 0) && <small className="pending-count">{s.pendingApprovalCount} 项审批 · {s.pendingUserInputCount} 项待答</small>}
      <span className="row-arrow" aria-hidden="true">↗</span>
    </Link>)}</div>
    {!state.loading && !state.sessions.length && <div className="empty">还没有匹配的会话。<p>换个关键词，或发起一段新对话。</p></div>}
    {state.hasMore && <button className="load-more" disabled={state.moreLoading || state.loading} onClick={() => void control.loadList(true)}>{state.moreLoading ? "加载中…" : "加载更多会话"}</button>}
    <p className="hint refresh-note">按需刷新 · {time(state.updatedAt)} 更新</p>
  </section>;
}

function NewSession({ control, state }: { control: ControlState; state: ViewState }) {
  const [workerId, setWorkerId] = useState(""), [workspace, setWorkspace] = useState("");
  const [input, setInput] = useState("");
  const choices = state.workers.filter(w => w.status === "online" && w.capabilities.includes("session-actions"));
  const worker = choices.find(w => w.id === workerId);
  const spaces = worker?.recentWorkspaces?.length ? worker.recentWorkspaces : (worker?.workspaces ?? []).map(path => ({ name: path, path }));
  const busy = Boolean(state.intent && (state.intent.submitting || state.intent.uncertain || state.intent.receipt?.status === "accepted"));
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(workspace);
  return <section><Link className="back" to="/control/sessions">← 最近会话</Link>
    <div className="page-heading"><div><div className="eyebrow">START SOMETHING</div><h1>新的对话</h1></div></div>
    <form className="panel new-form" onSubmit={e => {
      e.preventDefault(); if (!worker || !absolute || busy || !state.writable) return;
      void control.submit("/sessions", { workerId, workspace, ...(input.trim() ? { input } : {}) });
    }}>
      <label htmlFor="new-worker">由谁来执行</label><select id="new-worker" value={workerId} required onChange={e => { setWorkerId(e.target.value); setWorkspace(""); }}>
        <option value="">选择在线 Worker</option>{choices.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      {!choices.length && <p className="hint">没有在线且支持会话操作的 Worker，请刷新后重试。</p>}
      <label htmlFor="workspace">工作目录</label><input id="workspace" list="recent-spaces" value={workspace} required
        onChange={e => setWorkspace(e.target.value)} placeholder="选择最近目录，或输入目标机器绝对路径" autoCapitalize="none" spellCheck={false} />
      <datalist id="recent-spaces">{spaces.map(s => <option key={s.path} value={s.path}>{s.name}</option>)}</datalist>
      {worker && spaces.length > 0 && <div className="workspace-choices">{spaces.slice(0, 6).map(s => <button type="button" key={s.path} onClick={() => setWorkspace(s.path)}>{s.name}</button>)}</div>}
      {workspace && !absolute && <p className="hint">请使用目标机器上的绝对路径。</p>}
      <label htmlFor="first-message">第一条消息 <span className="muted">（可选）</span></label><textarea id="first-message" rows={6} value={input} onChange={e => setInput(e.target.value)} placeholder="想让 Agent 做什么？" />
      <p className="hint">沿用 Agent 默认模型和推理设置。路径由目标 Bridge 校验。</p>
      <button className="primary" disabled={!state.writable || !worker || !absolute || busy}>{busy ? "正在创建…" : "创建对话 →"}</button>
    </form></section>;
}

function EventView({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  const p = event.payload;
  if (event.type === "message.completed") return <article className={`message ${p.role === "user" ? "user" : "assistant"}`}>
    <div className="message-label">{p.role === "user" ? "你" : p.role === "assistant" ? "AGENT" : "SYSTEM"}<time>{time(event.timestamp)}</time></div>
    <div className="message-text">{typeof p.text === "string" ? p.text : "（无文本消息）"}</div>
  </article>;
  if (["tool.started", "tool.completed", "command.completed", "file_change.completed", "task.started", "task.progress", "task.completed"].includes(event.type)) {
    const summary = String(p.command ?? p.summary ?? p.description ?? p.name ?? event.type);
    return <details className="tool" onToggle={e => setOpen(e.currentTarget.open)}><summary>{summary.slice(0, 180)}</summary>{open && <pre>{JSON.stringify(p, null, 2)}</pre>}</details>;
  }
  if (event.type === "progress") return <p className="progress-note">{String(p.summary ?? "正在思考…")}</p>;
  const label: Record<string, string> = { "turn.started": "开始执行", "turn.completed": "本轮完成", "turn.failed": "本轮失败", "turn.interrupted": "本轮已打断",
    "approval.requested": "请求审批", "approval.resolved": "审批已处理", "user_input.requested": "等待回答", "user_input.resolved": "问题已回答", error: "执行异常" };
  return label[event.type] ? <div className="event-note"><span>{label[event.type]}</span>{Boolean(p.error || p.summary && event.type !== "turn.completed") && <p>{String(p.error ?? p.summary)}</p>}</div> : null;
}

function Detail({ control, state, id }: { control: ControlState; state: ViewState; id: string }) {
  const session = state.session?.sessionId === id ? state.session : undefined;
  const worker = state.workers.find(w => w.id === session?.workerId);
  const caps = session?.capabilities ?? worker?.capabilities ?? [];
  const online = worker?.status === "online" && session?.status !== "offline";
  const busy = Boolean(state.intent && (state.intent.submitting || state.intent.uncertain || state.intent.receipt?.status === "accepted"));
  const canOperate = state.writable && online && caps.includes("session-actions") && !state.loading && !busy;
  const blocked = Boolean(session && (session.pendingApprovalCount || session.pendingUserInputCount || session.status.startsWith("waiting")));
  const running = isLive(session);
  const draft = state.drafts[id] ?? "";
  const bottom = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true), [unread, setUnread] = useState(0), previous = useRef<string[]>([]);
  const anchor = useRef<{ top: number; height: number }>();
  useEffect(() => { if (!state.moreLoading) anchor.current = undefined; }, [state.moreLoading]);
  useEffect(() => {
    const scroll = () => { follow.current = window.scrollY + window.innerHeight > document.documentElement.scrollHeight - 160; if (follow.current) setUnread(0); };
    window.addEventListener("scroll", scroll, { passive: true }); return () => window.removeEventListener("scroll", scroll);
  }, []);
  useLayoutEffect(() => {
    if (anchor.current) {
      window.scrollTo({ top: anchor.current.top + (transcript.current?.scrollHeight ?? 0) - anchor.current.height });
      anchor.current = undefined;
    } else if (state.events.length) {
      const known = new Set(previous.current), count = state.events.filter(e => !known.has(e.eventId)).length;
      if (follow.current) bottom.current?.scrollIntoView({ block: "end" });
      else if (previous.current.length) setUnread(v => v + count);
    }
    previous.current = state.events.map(e => e.eventId);
  }, [state.events]);
  return <section className="detail-page"><Link className="back" to="/control/sessions">← 最近会话</Link>
    <div className="detail-heading"><div className="eyebrow">CONVERSATION</div><h1>{session ? title(session) : state.loading ? "正在读取会话…" : "会话详情"}</h1></div>
    {session && <>
      <div className="detail-status"><div><Status status={session.status} /><small aria-live="polite">{state.connection}</small></div>
        <button className="interrupt" disabled={!canOperate || !session.activeTurnId || !running || !caps.includes("turn-interrupt")}
          onClick={() => void control.submit(`/sessions/${segment(id)}/interrupt`, { expectedTurnId: session.activeTurnId })}>■ 打断</button></div>
      <details className="session-info"><summary>{session.agent} <span>·</span> {session.machineId} <span>·</span> {session.projectName}</summary>
        <p className="break-all">{session.workspace}</p><small className="break-all">Session · {id}</small>
        <p className="hint">历史覆盖：{session.historyCompleteness ?? "未知"} · {session.source ?? "未知来源"}</p></details>
      <div className="detail-tools"><small>完整消息与事件实时更新</small><button className="quiet" disabled={state.loading} onClick={() => void control.refresh()}>↻ 刷新</button></div>
      {session.error && <p className="error">{session.error.error.message}</p>}
      {(state.approvals.length > 0 || state.inputs.length > 0 || blocked) && <aside className="pending-panel"><strong>需要在原客户端处理</strong>
        {state.approvals.map(p => <p key={p.id ?? p.approvalId}>审批 · {p.summary ?? p.kind}</p>)}
        {state.inputs.map(p => <div key={p.id ?? p.requestId}>{p.questions?.map(q => <p key={q.id}>问题 · {q.isSecret ? "请在本机安全回答" : q.question}</p>)}</div>)}
        <small>此处只读展示；处理后将实时更新。</small></aside>}
    </>}
    <div className="transcript" ref={transcript}>
      {state.historyMore && <button className="load-more" disabled={state.moreLoading} onClick={() => {
        anchor.current = { top: window.scrollY, height: transcript.current?.scrollHeight ?? 0 }; void control.moreHistory();
      }}>{state.moreLoading ? "读取中…" : "↑ 加载更早内容"}</button>}
      {state.events.map(e => <EventView key={e.eventId} event={e} />)}
      {!state.loading && !state.events.length && <div className="empty">还没有已记录的内容。</div>}
      <div ref={bottom} className="transcript-end" />
    </div>
    {unread > 0 && <button className="new-content" onClick={() => { follow.current = true; setUnread(0); bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }}>↓ {unread} 条新内容</button>}
    {session && <form className="composer" onSubmit={e => {
      e.preventDefault(); if (!canOperate || !draft.trim() || blocked) return;
      const body = session.activeTurnId ? { input: draft, delivery: "steer", expectedTurnId: session.activeTurnId }
        : { input: draft, delivery: "start_turn" };
      void control.submit(`/sessions/${segment(id)}/turns`, body, id);
    }}><label className="sr-only" htmlFor="message">发送消息</label>
      <textarea id="message" rows={3} value={draft} onChange={e => control.setDraft(id, e.target.value)} placeholder={blocked ? "请先处理审批或问题" : running ? "追加指令…" : "继续这段对话…"} />
      <div className="composer-actions"><small>{!state.writable ? "只读模式" : blocked ? "等待处理待办" : !online ? "Worker 离线" : running && !session.activeTurnId ? "等待 turn 信息" : "Enter 换行"}</small>
        <button className="primary" disabled={!canOperate || !draft.trim() || blocked || Boolean(running && (!session.activeTurnId || !caps.includes("turn-steer"))) || !["idle", "active"].includes(session.status)}>{running ? "追加指令 ↑" : "发送 ↑"}</button></div>
    </form>}
  </section>;
}

createRoot(document.getElementById("root")!).render(<App />);
