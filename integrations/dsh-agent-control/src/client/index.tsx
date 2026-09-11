import { useDialog } from './dialog.js'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import css from './workspace.module.css'
import { openBridgeStream } from './bridge-stream.js'

import { SessionStore, type BridgeRpc } from './session-store.js'
import { SessionCreationController, SessionSourcePicker, type CreationSessions, type CreationWorkspaces, type CreationNavigation } from './session-creation.js'


const RPC_CHANNEL = '/agent-control'
const markdownLabels = { code: { copyLabel:'复制', copiedLabel:'已复制' }, footnotes:'脚注' }
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type RecordValue = Record<string, JsonValue>

/** Management overlay only. DSH owns its session tree and conversation. */
export class WorkspaceController {
  readonly sessions: SessionStore
  error = ''
  private openValue = false
  private panelValue: 'overview' | 'tasks' = 'overview'
  private listeners = new Set<() => void>()
  constructor(private readonly rpc: BridgeRpc = (operation, args) => call('bridge', operation, args),
    loadNativeModelCatalog?: () => Promise<JsonValue>, private readonly openNative?: (id: string) => void) {
    this.sessions = new SessionStore(rpc, loadNativeModelCatalog, openBridgeStream)
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = (): boolean => this.openValue
  panelSnapshot = (): 'overview' | 'tasks' => this.panelValue
  openSession = (id: string): void => { void this.openLinkedSession(id) }
  private async openLinkedSession(id: string): Promise<void> {
    try {
      const result = asRecord(await this.rpc('import' as never, { sessionId: id }))
      if (typeof result['nativeSessionId'] !== 'string') throw new Error('Native session identity is missing')
      this.openNative?.(result['nativeSessionId'])
      this.error = ''; this.openValue = false
    } catch (error) { this.error = error instanceof Error ? error.message : String(error) }
    this.emit()
  }
  open = (): void => { this.panelValue = 'overview'; this.openValue = true; this.sessions.activate(); this.emit() }
  openKanban = (): void => { this.panelValue = 'tasks'; this.openValue = true; this.sessions.activate(); this.emit() }
  close = (): void => { this.openValue = false; this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
}
interface Injected { controller: WorkspaceController }
type FooterProps = PropsRuntime<'sidebar.footer.action'> & Injected

export function FooterAction({ wide, controller }: FooterProps) {
  return <div>
    <button className={css.footerButton} type="button" onClick={controller.open} aria-label="Open Agent Control">
      <span aria-hidden="true">⌘</span>{wide && <span>Agent Control</span>}
    </button>
    <button type="button" className={css.footerButton} aria-label="Open Kanban" onClick={controller.openKanban}><span aria-hidden="true">▦</span>{wide && <span>Kanban</span>}</button>
  </div>
}
function useController(controller: WorkspaceController): boolean {
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
}

type RpcConnection = { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: JsonValue; error?: { message?: string; code?: string } }> } }
let connection: RpcConnection | undefined
async function call(domain: 'overview' | 'bridge' | 'kanban', operation: string, args?: RecordValue): Promise<JsonValue> {
  if (!connection) throw new Error('Agent Control connection is not ready')
  const envelope = await connection.rpc.call(RPC_CHANNEL, 'dispatch', { domain, operation, ...(args ? { args } : {}) })
  if (!envelope.ok) throw new Error(envelope.error?.message ?? envelope.error?.code ?? 'Agent Control request failed')
  return envelope.value ?? null
}

function asRecord(value: JsonValue | undefined): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function asArray(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : [] }
function str(value: JsonValue | undefined, fallback = '—'): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback }
function sessionTitle(session: RecordValue): string {
  const title = typeof session['title'] === 'string' ? session['title'].trim() : ''
  if (title) return title
  const project = typeof session['projectName'] === 'string' && session['projectName'].trim() ? session['projectName'].trim() : 'Session'
  const id = typeof session['sessionId'] === 'string' ? session['sessionId'].slice(0, 8) : 'unknown'
  return `${project} · ${id}`
}
function statusClass(status: string): string { return `${css.status} ${css[`status_${status}`] ?? ''}` }
const labels: Record<string, string> = { online:'在线', offline:'离线', active:'运行中', running:'运行中', idle:'空闲', waiting_for_approval:'待审批', waiting_for_input:'待回复', error:'异常', unknown:'未知', triage:'待分类', todo:'待办', scheduled:'已排期', ready:'就绪', blocked:'受阻', review:'待审核', done:'已完成' }
function statusLabel(value: JsonValue | undefined) { const name = str(value); return labels[name] ?? name }

function Empty({ children }: { children: ReactNode }) { return <div className={css.empty}>{children}</div> }
function ErrorBanner({ error, retry }: { error: string; retry(): void }) {
  return <div className={css.error} role="alert"><span>{error}</span><button type="button" onClick={retry}>重试</button></div>
}

export function Overview({ data, openSession }: { data: RecordValue; openSession(id: string): void }) {
  const bridge = asRecord(data['bridge'])
  const workers = asArray(bridge['workers']).map(asRecord)
  const sessions = asArray(bridge['sessions']).map(asRecord)
  const counts = asRecord(data['counts'])
  const board = asRecord(data['board'])
  const columns = asArray(board['columns']).map(asRecord)
  const sessionProvider = asRecord(data['sessionProvider'])
  const [showOffline, setShowOffline] = useState(false)
  const visibleWorkers = workers.filter(worker => showOffline || worker['status'] === 'online').sort((a,b) => Number(b['status'] === 'online') - Number(a['status'] === 'online') || str(a['name']).localeCompare(str(b['name'])))
  return <div className={css.page}>
    <div className={css.pageHeading}><div><h2>运行概览</h2><p>查看机器连接、会话状态与任务进展。</p></div><span className={css.syncSummary}>已同步 {Number(sessionProvider['nativeSessions'] ?? 0)} 个对话</span></div>
    {sessionProvider['registered'] !== true ? <div className={css.notice} role="status">正在连接会话同步服务…</div> : typeof sessionProvider['error'] === 'string' && sessionProvider['error'] ? <div className={css.error} role="alert">部分对话同步失败：{sessionProvider['error']}</div> : null}
    <div className={css.metrics}>
      <Metric label="在线 Worker" value={workers.filter(worker => worker['status'] === 'online').length} tone="good" />
      <Metric label="运行中" value={Number(counts['active'] ?? 0)} />
      <Metric label="等待处理" value={Number(counts['waiting_for_input'] ?? 0) + Number(counts['waiting_for_approval'] ?? 0)} tone="warn" />
      <Metric label="需要关注" value={Number(data['needsAttention'] ?? 0)} tone="danger" />
    </div>
    <div className={css.twoCol}>
      <section className={css.panel}><div className={css.panelHeading}><h2>Workers</h2><label><input type="checkbox" checked={showOffline} onChange={event => setShowOffline(event.target.checked)} />显示离线</label></div>{visibleWorkers.length === 0 ? <Empty>暂无在线 Worker，可勾选查看离线机器。</Empty> : visibleWorkers.map(worker => <div className={css.row} key={str(worker['id'])}>
        <span className={statusClass(str(worker['status']))} />
        <div><strong>{str(worker['name'])}</strong><small>{str(worker['hostname'])} · Bridge {str(worker['bridgeVersion'], '版本未知')} · {str(asArray(sessionProvider['workers']).map(asRecord).find(item => item['workerId'] === worker['id'])?.['sessions'], '0')} 个对话</small></div>
        <span className={css.rowMeta}>{statusLabel(worker['status'])}</span>
      </div>)}</section>
      <section className={css.panel}><h2>最近对话</h2>{sessions.length === 0 && <Empty>暂无对话</Empty>}{sessions.slice(0, 6).map(session => <button type="button" className={`${css.row} ${css.rowButton}`} key={str(session['sessionId'])} onClick={() => openSession(str(session['sessionId']))}>
        <span className={statusClass(str(session['status']))} />
        <div><strong>{sessionTitle(session)}</strong><small title={str(session['workspace'])}>{str(session['workspace'])}</small></div>
        <span className={css.rowMeta}>{statusLabel(session['status'])} ↗</span>
      </button>)}</section>
    </div>
    <section className={css.panel}><h2>任务分布</h2><div className={css.columnPulse}>{columns.map(column => <div key={str(column['name'])}><span>{statusLabel(column['name'])}</span><strong>{asArray(column['tasks']).length}</strong></div>)}</div></section>
  </div>
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className={`${css.metric} ${tone ? css[`tone_${tone}`] : ''}`}><span>{label}</span><strong>{value}</strong></div>
}

export function Tasks({ snapshot, refresh, openSession }: { snapshot: RecordValue; refresh(): Promise<void>; openSession(sessionId: string): void }) {
  const board = asRecord(snapshot['board'])
  const bridgeSessions = asArray(asRecord(snapshot['bridge'])['sessions']).map(asRecord)
  const columns = asArray(board['columns']).map(asRecord)
  const assignees = asArray(board['assignees']).filter((item): item is string => typeof item === 'string')
  const [detail, setDetail] = useState<RecordValue>()
  const [createOpen, setCreateOpen] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('')
  const [loadingTask, setLoadingTask] = useState('')
  const taskEpoch = useRef(0)
  useEffect(() => () => { taskEpoch.current++ }, [])
  const openTask = async (taskId: string) => { const epoch = ++taskEpoch.current; setLoadingTask(taskId); try { const result = asRecord(await call('kanban', 'show', { taskId })); if (epoch === taskEpoch.current) { setDetail(result); setError('') } } catch (cause) { if (epoch === taskEpoch.current) setError(cause instanceof Error ? cause.message : '任务加载失败') } finally { if (epoch === taskEpoch.current) setLoadingTask('') } }
  const filtered = columns.map(column => ({name:column['name'], tasks:asArray(column['tasks']).map(asRecord).filter(task => (!owner || str(task['assignee'], '') === owner) && [task['title'],task['id'],task['assignee']].some(value => str(value, '').toLowerCase().includes(query.trim().toLowerCase())))}))
  const visible = filtered.filter(column => showEmpty || column.tasks.length > 0)
  const total = columns.reduce((sum, column) => sum + asArray(column['tasks']).length, 0)
  const shown = filtered.reduce((sum, column) => sum + column.tasks.length, 0)
  return <div className={css.taskPage}>
    <div className={css.pageHeading}><div><h2>任务看板</h2><p>按阶段查看任务，点击卡片查看详情。</p></div><span className={css.syncSummary}>{shown} / {total} 个任务</span></div>
    <div className={css.taskToolbar}><input type="search" className={css.search} aria-label="搜索任务" placeholder="搜索标题、编号或负责人…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选负责人" value={owner} onChange={event => setOwner(event.target.value)}><option value="">全部负责人</option>{assignees.map(name => <option key={name}>{name}</option>)}</select><label><input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)} />显示空列</label><button type="button" className={css.primary} onClick={() => { setError(''); setCreateOpen(true) }}>＋ 新建任务</button></div>
    {error && <div className={css.error} role="alert">{error}</div>}
    {loadingTask && <div className={css.notice} role="status">正在加载任务详情…</div>}
    {shown === 0 && <Empty>{total === 0 ? '暂无任务，创建第一个任务开始协作。' : '没有匹配的任务，请调整搜索或负责人筛选。'}</Empty>}
    <div className={css.board}>{visible.map(column => <section className={css.kanbanColumn} key={str(column['name'])}><header><span>{statusLabel(column['name'])}</span><strong>{column.tasks.length}</strong></header><div className={css.columnTasks}>{column.tasks.length === 0 && <Empty>暂无任务</Empty>}{column.tasks.map(task => <button type="button" className={css.taskCard} key={str(task['id'])} onClick={() => void openTask(str(task['id']))} aria-busy={loadingTask === str(task['id'])}><small>{str(task['id'])}</small><strong>{str(task['title'])}</strong><footer><span>{str(task['assignee'], '未分配')}</span><span className={css.priority}>P{str(task['priority'], '0')}</span></footer></button>)}</div></section>)}</div>
    {detail && <TaskDrawer data={detail} associatedSessions={bridgeSessions.filter(session => session['taskId'] === asRecord(detail['task'])['id'])} openSession={openSession} close={() => setDetail(undefined)} refresh={async () => { await refresh(); await openTask(str(asRecord(detail['task'])['id'])) }} />}
    {createOpen && <CreateTask assignees={assignees} busy={busy} error={error} close={() => setCreateOpen(false)} submit={async args => { setBusy(true); try { await call('kanban', 'create', args); setCreateOpen(false); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Create failed') } finally { setBusy(false) } }} />}
  </div>
}

function TaskDrawer({ data, associatedSessions, openSession, close, refresh }: { data: RecordValue; associatedSessions: RecordValue[]; openSession(sessionId: string): void; close(): void; refresh(): Promise<void> }) {
  const task = asRecord(data['task']); const comments = asArray(data['comments']).map(asRecord); const runs = asArray(data['runs']).map(asRecord); const links = asRecord(data['links'])
  const [comment, setComment] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewSummary, setReviewSummary] = useState('')
  const ref = useDialog(true, () => { if (!busy) close() })
  const post = async (event: FormEvent) => { event.preventDefault(); if (!comment.trim()) return; setBusy(true); try { await call('kanban', 'comment', { taskId: str(task['id']), body: comment.trim() }); setComment(''); await refresh() } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Comment failed') } finally { setBusy(false) } }
  return <div className={css.drawerBackdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="任务详情" className={css.drawer}>
    <header><div><small>{str(task['id'])}</small><h2>{str(task['title'])}</h2></div><button type="button" className={css.iconButton} aria-label="关闭任务详情" disabled={busy} onClick={close}>×</button></header>
    <div className={css.taskFacts}><span>{statusLabel(task['status'])}</span><span>{str(task['assignee'], '未分配')}</span><span>P{str(task['priority'], '0')}</span></div>
    <div className={css.markdown}><MarkdownText text={str(task['body'], '暂无描述。')} labels={markdownLabels} /></div>
    <div className={css.taskActions}>
      {(task['status'] === 'ready' || task['status'] === 'running') && <button type="button" disabled={busy} onClick={() => setReviewOpen(value => !value)}>申请审核</button>}
      {task['status'] === 'blocked' && <button type="button" disabled={busy} onClick={() => { setBusy(true); void call('kanban', 'unblock', { taskId: str(task['id']) }).then(refresh).catch(error => setNotice(error instanceof Error ? error.message : 'Unblock failed')).finally(() => setBusy(false)) }}>解除阻塞</button>}
    </div>
    {reviewOpen && <form className={css.commentForm} onSubmit={event => { event.preventDefault(); if (busy || !reviewSummary.trim()) return; setBusy(true); void call('kanban', 'request_review', {taskId:str(task['id']),summary:reviewSummary.trim(),force:false}).then(async () => { setReviewOpen(false); await refresh() }).catch(error => setNotice(error instanceof Error ? error.message : '申请审核失败')).finally(() => setBusy(false)) }}><label htmlFor="review-summary">审核交接说明</label><textarea id="review-summary" value={reviewSummary} disabled={busy} onChange={event => setReviewSummary(event.target.value)} placeholder="说明完成内容、验证结果和待确认事项…" /><button className={css.primary} type="submit" disabled={busy || !reviewSummary.trim()}>{busy ? '正在提交…' : '提交审核'}</button></form>}
    {notice && <div className={css.error} role="alert">{notice}</div>}
    {associatedSessions.length > 0 && <><h3>关联对话</h3>{associatedSessions.map(session => <button className={css.sessionLink} type="button" key={str(session['sessionId'])} onClick={() => openSession(str(session['sessionId']))}>{sessionTitle(session)} · {str(session['status'])}</button>)}</>}
    <h3>依赖关系</h3><p>上游：{asArray(links['parents']).map(String).join(', ') || '无'}<br />下游：{asArray(links['children']).map(String).join(', ') || '无'}</p>
    <h3>执行记录</h3>{runs.length === 0 ? <Empty>暂无执行记录。</Empty> : runs.map(run => <div className={css.run} key={str(run['id'])}><strong>执行 #{str(run['id'])}</strong><span>{statusLabel(run['outcome'] ?? run['status'])}</span><div className={css.markdown}><MarkdownText text={str(run['summary'], '')} labels={markdownLabels} /></div></div>)}
    <h3>评论</h3>{comments.length === 0 && <p className={css.help}>暂无评论。</p>}{comments.map(item => <div className={css.comment} key={str(item['id'])}><strong>{str(item['author'])}</strong><div className={css.markdown}><MarkdownText text={str(item['body'])} labels={markdownLabels} /></div></div>)}
    <form className={css.commentForm} onSubmit={event => void post(event)}><textarea aria-label="添加评论" value={comment} disabled={busy} onChange={event => setComment(event.target.value)} placeholder="添加评论…" /><button type="submit" disabled={busy || !comment.trim()}>{busy ? '正在提交…' : '发表评论'}</button></form>
  </div></div>
}

function CreateTask({ assignees, busy, error, close, submit }: { assignees: string[]; busy: boolean; error: string; close(): void; submit(args: RecordValue): Promise<void> }) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [workspace, setWorkspace] = useState('')
  const ref = useDialog(true, () => { if (!busy) close() })
  return <div className={css.drawerBackdrop}><div ref={ref} role="dialog" aria-modal="true" aria-label="新建任务" tabIndex={-1} className={css.modal}><form className={css.commentForm} onSubmit={event => { event.preventDefault(); if (busy || !title.trim()) return; void submit({ title: title.trim(), body, ...(assignee ? { assignee } : {}), workspaceKind: workspace ? 'dir' : 'scratch', ...(workspace ? { workspacePath: workspace } : {}), priority: 0, goalMode: false }) }}>
    <header className={css.dialogHeader}><h2>新建任务</h2><button type="button" className={css.iconButton} aria-label="关闭新建任务" disabled={busy} onClick={close}>×</button></header>
    {error && <div role="alert">{error}</div>}
    <label>标题<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>描述<textarea value={body} onChange={event => setBody(event.target.value)} /></label>
    <label>负责人<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">未分配</option>{assignees.map(name => <option key={name}>{name}</option>)}</select></label>
    <label>工作目录（可选，填写绝对路径）<input value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
    <button type="submit" className={css.primary} disabled={busy || !title.trim()}>{busy ? '正在创建…' : '创建任务'}</button>
  </form></div></div>
}

function WorkspaceOverlay({ controller }: Injected) {
  const open = useController(controller)
  const ref = useDialog(open, controller.close)
  const panel = useSyncExternalStore(controller.subscribe, controller.panelSnapshot, controller.panelSnapshot)
  const sessionStore = controller.sessions
  const [tab, setTab] = useState<'overview' | 'tasks'>('overview')
  useEffect(() => { if (open) setTab(panel) }, [panel, open])
  const [data, setData] = useState<RecordValue>()
  const [loadedTab, setLoadedTab] = useState<'overview' | 'tasks'>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestEpoch = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current
    setLoading(true)
    try {
      const result = tab === 'tasks' ? { board: await call('kanban', 'list'), bridge: { sessions: sessionStore.snapshot().sessions } } : asRecord(await call('overview', 'snapshot'))
      if (epoch !== requestEpoch.current) return
      setData(result); setLoadedTab(tab); setError('')
    } catch (cause) { if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Agent Control unavailable') }
    finally { if (epoch === requestEpoch.current) setLoading(false) }
  }, [tab, sessionStore])
  useEffect(() => { if (open) void refresh(); return () => { requestEpoch.current++ } }, [open, refresh])
  const content = useMemo(() => { if (!data) return null; if (tab === 'tasks') return <Tasks snapshot={data} refresh={refresh} openSession={controller.openSession} />; return <Overview data={data} openSession={controller.openSession} /> }, [data, refresh, tab, sessionStore, controller])
  if (!open) return null
  return <div ref={ref} tabIndex={-1} className={css.workspace} role="dialog" aria-modal="true" aria-label="Agent Control workspace" aria-busy={loading}>
    <header className={css.topbar}><div className={css.title}><span className={css.logo}>AC</span><div><strong>Agent Control</strong><small>机器、对话与任务</small></div></div><nav aria-label="管理视图">{(['overview', 'tasks'] as const).map(item => <button aria-current={tab === item ? 'page' : undefined} className={tab === item ? css.activeTab : ''} key={item} type="button" onClick={() => { setError(''); setTab(item) }}>{item === 'tasks' ? 'Kanban 看板' : '运行概览'}</button>)}</nav><div className={css.topActions}><button type="button" aria-label="Refresh Agent Control" onClick={() => void refresh()} disabled={loading}>{loading ? '刷新中…' : '↻ 刷新'}</button><button type="button" onClick={controller.close}>关闭</button></div></header>
    {controller.error && <div className={css.error} role="alert">{controller.error}</div>}
    {error ? <ErrorBanner error={error} retry={() => void refresh()} /> : !data || loadedTab !== tab ? <div role="status" className={css.loading}>正在加载…</div> : content}
  </div>
}

export const inject = ['slots', 'connection', 'layout', 'remote', 'remote.session', 'sessions', 'workspaces', 'uiWorkspace']
export function apply(ctx: ClientContext): void {
  connection = (ctx as unknown as { connection: RpcConnection }).connection
  const remote = (ctx as unknown as { remote: { session: { modelCatalog(): Promise<{ ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } }> }; $on(event: string, listener: () => void): () => void } }).remote
  const nativeSessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as unknown as { open(id: string): void } | undefined
  const creation = new SessionCreationController((operation, args) => call('bridge', operation, args))
  ctx.effect(() => {
    let disposed = false
    let uninstall: (() => void) | undefined
    // Resolve sources at click time; Host startup must not permanently disable interception.
    if (!disposed) uninstall = creation.install(ctx.get('sessions') as unknown as CreationSessions, ctx.get('workspaces') as unknown as CreationWorkspaces, ctx.get('uiWorkspace') as unknown as CreationNavigation)
    return () => { disposed = true; uninstall?.() }
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control-session-source', order: 11, inject: () => ({ controller: creation }) }, SessionSourcePicker))
  const controller = new WorkspaceController(undefined, async () => {
    const response = await remote.session.modelCatalog()
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.value
  }, id => nativeSessions?.open(id))
  ctx.effect(() => {
    const refresh = () => controller.sessions.invalidateModels()
    const disposers = [remote.$on('llm/adapters-updated', refresh), remote.$on('settings/document-updated', refresh), remote.$on('credentials/reference-updated', refresh)]
    return () => { for (const dispose of disposers) dispose(); controller.sessions.dispose() }
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-control', order: 20, inject: (): Injected => ({ controller }) }, FooterAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control', order: 10, inject: (): Injected => ({ controller }) }, WorkspaceOverlay))
}
