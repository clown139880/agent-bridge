import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
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
import { SessionCreationController, SessionSourcePicker, type CreationSessions, type CreationWorkspaces } from './session-creation.js'


const RPC_CHANNEL = '/agent-control'
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
    <Button size="sm" className={css.footerButton} type="button" onClick={controller.open} aria-label="Open Agent Control">
      <span aria-hidden="true">⌘</span>{wide && <span>Agent Control</span>}
    </Button>
    <Button size="sm" type="button" className={css.footerButton} aria-label="Open Kanban" onClick={controller.openKanban}><span aria-hidden="true">▦</span>{wide && <span>Kanban</span>}</Button>
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

function Empty({ children }: { children: ReactNode }) { return <div className={css.empty}>{children}</div> }
function ErrorBanner({ error, retry }: { error: string; retry(): void }) {
  return <div className={css.error} role="alert"><span>{error}</span><Button size="sm" type="button" onClick={retry}>Retry</Button></div>
}

function Overview({ data }: { data: RecordValue }) {
  const bridge = asRecord(data['bridge'])
  const workers = asArray(bridge['workers']).map(asRecord)
  const sessions = asArray(bridge['sessions']).map(asRecord)
  const counts = asRecord(data['counts'])
  const board = asRecord(data['board'])
  const columns = asArray(board['columns']).map(asRecord)
  const sessionProvider = asRecord(data['sessionProvider'])
  return <div className={css.page}>
    {!('sessionProvider' in data) ? <div role="alert">The running Host has not loaded the Bridge session provider. Updating browser files alone does not activate session sync.</div> : sessionProvider['registered'] !== true ? <div role="alert">Bridge session sync is waiting for the Host services.</div> : typeof sessionProvider['error'] === 'string' && sessionProvider['error'] ? <div role="alert">Bridge session sync: {sessionProvider['error']}</div> : <div>Bridge conversations in Sessions: {Number(sessionProvider['nativeSessions'] ?? 0)}</div>}
    {asArray(sessionProvider['workers']).map(asRecord).map(worker => <div key={str(worker['workerId'])}>{str(worker['name'])}: {str(worker['sessions'])} sessions</div>)}
    <p>本机 Bridge 会话与 DSH 会话位于原来的本机目录中。</p>
    {sessionProvider['sourceSelection'] === true ? <p>目录的新建按钮可选择来源；支持图片提交。</p> : <p role="status">来源选择和图片转发需要 Host 加载新版插件；当前仍使用旧版新建行为。</p>}
    <div className={css.metrics}>
      <Metric label="Workers online" value={workers.filter(worker => worker['status'] === 'online').length} tone="good" />
      <Metric label="Active" value={Number(counts['active'] ?? 0)} />
      <Metric label="Waiting" value={Number(counts['waiting_for_input'] ?? 0) + Number(counts['waiting_for_approval'] ?? 0)} tone="warn" />
      <Metric label="Needs attention" value={Number(data['needsAttention'] ?? 0)} tone="danger" />
    </div>
    <div className={css.twoCol}>
      <section className={css.panel}><h2>Workers</h2>{workers.length === 0 ? <Empty>No workers reported.</Empty> : workers.map(worker => <div className={css.row} key={str(worker['id'])}>
        <span className={statusClass(str(worker['status']))} />
        <div><strong>{str(worker['name'])}</strong><small>{str(worker['hostname'])} · {asArray(worker['capabilities']).length} capabilities</small></div>
        <span className={css.rowMeta}>{str(worker['status'])}</span>
      </div>)}</section>
      <section className={css.panel}><h2>Recent sessions</h2>{sessions.slice(0, 6).map(session => <div className={css.row} key={str(session['sessionId'])}>
        <span className={statusClass(str(session['status']))} />
        <div><strong>{sessionTitle(session)}</strong><small>{str(session['workspace'])}</small></div>
        <span className={css.rowMeta}>{str(session['status'])}</span>
      </div>)}</section>
    </div>
    <section className={css.panel}><h2>Kanban pulse</h2><div className={css.columnPulse}>{columns.map(column => <div key={str(column['name'])}><span>{str(column['name'])}</span><strong>{asArray(column['tasks']).length}</strong></div>)}</div></section>
  </div>
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className={`${css.metric} ${tone ? css[`tone_${tone}`] : ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function Tasks({ snapshot, refresh, openSession }: { snapshot: RecordValue; refresh(): Promise<void>; openSession(sessionId: string): void }) {
  const board = asRecord(snapshot['board'])
  const bridgeSessions = asArray(asRecord(snapshot['bridge'])['sessions']).map(asRecord)
  const columns = asArray(board['columns']).map(asRecord)
  const assignees = asArray(board['assignees']).filter((item): item is string => typeof item === 'string')
  const [detail, setDetail] = useState<RecordValue>()
  const [createOpen, setCreateOpen] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const openTask = async (taskId: string) => { try { setDetail(asRecord(await call('kanban', 'show', { taskId }))); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Task load failed') } }
  return <div className={css.taskPage}>
    <div className={css.taskToolbar}><span>{columns.reduce((sum, column) => sum + asArray(column['tasks']).length, 0)} tasks</span><label><input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)} /> Show empty columns</label><Button size="sm" type="button" onClick={() => setCreateOpen(true)}>Create task</Button></div>
    {error && <div className={css.notice}>{error}</div>}
    {!showEmpty && columns.every(column => asArray(column['tasks']).length === 0) && <Empty>No tasks in this board.</Empty>}<div className={css.board}>{columns.filter(column => showEmpty || asArray(column['tasks']).length > 0).map(column => <section className={css.kanbanColumn} key={str(column['name'])}><header><span>{str(column['name'])}</span><strong>{asArray(column['tasks']).length}</strong></header>{asArray(column['tasks']).map(value => { const task = asRecord(value); return <Button size="sm" type="button" className={css.taskCard} key={str(task['id'])} onClick={() => void openTask(str(task['id']))}><strong>{str(task['title'])}</strong><small>{str(task['id'])}</small><footer><span>{str(task['assignee'], 'unassigned')}</span><span>P{str(task['priority'], '0')}</span></footer></Button> })}</section>)}</div>
    {detail && <TaskDrawer data={detail} associatedSessions={bridgeSessions.filter(session => session['taskId'] === asRecord(detail['task'])['id'])} openSession={openSession} close={() => setDetail(undefined)} refresh={async () => { await refresh(); await openTask(str(asRecord(detail['task'])['id'])) }} />}
    {createOpen && <CreateTask assignees={assignees} busy={busy} error={error} close={() => setCreateOpen(false)} submit={async args => { setBusy(true); try { await call('kanban', 'create', args); setCreateOpen(false); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Create failed') } finally { setBusy(false) } }} />}
  </div>
}

function TaskDrawer({ data, associatedSessions, openSession, close, refresh }: { data: RecordValue; associatedSessions: RecordValue[]; openSession(sessionId: string): void; close(): void; refresh(): Promise<void> }) {
  const task = asRecord(data['task']); const comments = asArray(data['comments']).map(asRecord); const runs = asArray(data['runs']).map(asRecord); const links = asRecord(data['links'])
  const [comment, setComment] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('')
  const post = async (event: FormEvent) => { event.preventDefault(); if (!comment.trim()) return; setBusy(true); try { await call('kanban', 'comment', { taskId: str(task['id']), body: comment.trim() }); setComment(''); await refresh() } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Comment failed') } finally { setBusy(false) } }
  return <div className={css.drawerBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) close() }}><aside className={css.drawer}>
    <header><div><small>{str(task['id'])}</small><h2>{str(task['title'])}</h2></div><Button size="sm" type="button" onClick={close}>×</Button></header>
    <div className={css.taskFacts}><span>{str(task['status'])}</span><span>{str(task['assignee'], 'unassigned')}</span><span>P{str(task['priority'], '0')}</span></div>
    <p className={css.body}>{str(task['body'], 'No description.')}</p>
    <div className={css.taskActions}>
      {(task['status'] === 'ready' || task['status'] === 'running') && <Button size="sm" type="button" disabled={busy} onClick={() => { const summary = window.prompt('Review handoff summary'); if (!summary?.trim()) return; setBusy(true); void call('kanban', 'request_review', { taskId: str(task['id']), summary: summary.trim(), force: false }).then(refresh).catch(error => setNotice(error instanceof Error ? error.message : 'Review request failed')).finally(() => setBusy(false)) }}>Request review</Button>}
      {task['status'] === 'blocked' && <Button size="sm" type="button" disabled={busy} onClick={() => { setBusy(true); void call('kanban', 'unblock', { taskId: str(task['id']) }).then(refresh).catch(error => setNotice(error instanceof Error ? error.message : 'Unblock failed')).finally(() => setBusy(false)) }}>Unblock</Button>}
    </div>
    {notice && <div className={css.notice}>{notice}</div>}
    {associatedSessions.length > 0 && <><h3>Agent Bridge sessions</h3>{associatedSessions.map(session => <Button size="sm" className={css.sessionLink} type="button" key={str(session['sessionId'])} onClick={() => openSession(str(session['sessionId']))}>{sessionTitle(session)} · {str(session['status'])}</Button>)}</>}
    <h3>Dependencies</h3><p>Parents: {asArray(links['parents']).map(String).join(', ') || 'none'}<br />Children: {asArray(links['children']).map(String).join(', ') || 'none'}</p>
    <h3>Runs</h3>{runs.length === 0 ? <Empty>No runs.</Empty> : runs.map(run => <div className={css.run} key={str(run['id'])}><strong>Run {str(run['id'])}</strong><span>{str(run['outcome'], str(run['status']))}</span><p>{str(run['summary'], '')}</p></div>)}
    <h3>Comments</h3>{comments.map(item => <div className={css.comment} key={str(item['id'])}><strong>{str(item['author'])}</strong><p>{str(item['body'])}</p></div>)}
    <form className={css.commentForm} onSubmit={event => void post(event)}><textarea value={comment} onChange={event => setComment(event.target.value)} placeholder="Add a durable comment…" /><Button size="sm" type="submit" disabled={busy || !comment.trim()}>Comment</Button></form>
  </aside></div>
}

function CreateTask({ assignees, busy, error, close, submit }: { assignees: string[]; busy: boolean; error: string; close(): void; submit(args: RecordValue): Promise<void> }) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [workspace, setWorkspace] = useState('')
  return <div className={css.drawerBackdrop}><form className={css.modal} onSubmit={event => { event.preventDefault(); void submit({ title: title.trim(), body, ...(assignee ? { assignee } : {}), workspaceKind: workspace ? 'dir' : 'scratch', ...(workspace ? { workspacePath: workspace } : {}), priority: 0, goalMode: false }) }}>
    <header><h2>Create task</h2><Button size="sm" type="button" onClick={close}>×</Button></header>
    {error && <div role="alert">{error}</div>}
    <label>Title<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>Description<textarea value={body} onChange={event => setBody(event.target.value)} /></label>
    <label>Assignee<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{assignees.map(name => <option key={name}>{name}</option>)}</select></label>
    <label>Workspace (optional absolute dir)<input value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
    <Button size="sm" type="submit" className={css.primary} disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
  </form></div>
}

function WorkspaceOverlay({ controller }: Injected) {
  const open = useController(controller)
  const panel = useSyncExternalStore(controller.subscribe, controller.panelSnapshot, controller.panelSnapshot)
  const sessionStore = controller.sessions
  const [tab, setTab] = useState<'overview' | 'tasks'>('overview')
  useEffect(() => { if (open) setTab(panel) }, [panel, open])
  const [data, setData] = useState<RecordValue>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestEpoch = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current
    setLoading(true)
    try {
      const result = tab === 'tasks' ? { board: await call('kanban', 'list'), bridge: { sessions: sessionStore.snapshot().sessions } } : asRecord(await call('overview', 'snapshot'))
      if (epoch !== requestEpoch.current) return
      setData(result); setError('')
    } catch (cause) { if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Agent Control unavailable') }
    finally { if (epoch === requestEpoch.current) setLoading(false) }
  }, [tab, sessionStore])
  useEffect(() => { if (open) void refresh() }, [open, refresh, tab])
  useEffect(() => { if (!open) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') controller.close() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [controller, open])
  const content = useMemo(() => { if (!data) return null; if (tab === 'tasks') return <Tasks snapshot={data} refresh={refresh} openSession={controller.openSession} />; return <Overview data={data} /> }, [data, refresh, tab, sessionStore, controller])
  if (!open) return null
  return <div className={css.workspace} role="dialog" aria-modal="true" aria-label="Agent Control workspace">
    <header className={css.topbar}><div className={css.title}><span className={css.logo}>AC</span><div><strong>Agent Control</strong><small>Bridge orchestration</small></div></div><nav>{(['overview', 'tasks'] as const).map(item => <Button size="sm" className={tab === item ? css.activeTab : ''} key={item} type="button" onClick={() => setTab(item)}>{item === 'tasks' ? 'Kanban' : item}</Button>)}</nav><div className={css.topActions}><Button size="sm" type="button" aria-label="Refresh Agent Control" onClick={() => void refresh()} disabled={loading}>↻</Button><Button size="sm" type="button" onClick={controller.close}>Close</Button></div></header>
    {controller.error && <div role="alert">{controller.error}</div>}
    {error ? <ErrorBanner error={error} retry={() => void refresh()} /> : loading && !data ? <div className={css.loading}>Loading Agent Control…</div> : content}
  </div>
}

export const inject = ['slots', 'connection', 'layout', 'remote', 'remote.session', 'sessions', 'workspaces']
export function apply(ctx: ClientContext): void {
  connection = (ctx as unknown as { connection: RpcConnection }).connection
  const remote = (ctx as unknown as { remote: { session: { modelCatalog(): Promise<{ ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } }> }; $on(event: string, listener: () => void): () => void } }).remote
  const nativeSessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as unknown as { open(id: string): void } | undefined
  const creation = new SessionCreationController((operation, args) => call('bridge', operation, args))
  ctx.effect(() => {
    let disposed = false
    let uninstall: (() => void) | undefined
    void call('bridge', 'provider_status').then(status => {
      if (!disposed && asRecord(status)['sourceSelection'] === true) uninstall = creation.install(ctx.get('sessions') as unknown as CreationSessions, ctx.get('workspaces') as unknown as CreationWorkspaces)
    }).catch(() => { /* Preserve native creation while the Host provider is unavailable. */ })
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
