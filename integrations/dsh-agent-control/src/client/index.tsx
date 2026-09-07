import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import css from './workspace.module.css'

const RPC_CHANNEL = '/agent-control'
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type RecordValue = Record<string, JsonValue>

export class WorkspaceController {
  private openValue = false
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  snapshot = (): boolean => this.openValue
  open = (): void => { this.openValue = true; this.emit() }
  close = (): void => { this.openValue = false; this.emit() }
  private emit(): void { for (const listener of this.listeners) listener() }
}

interface Injected { controller: WorkspaceController }
type FooterProps = PropsRuntime<'sidebar.footer.action'> & Injected

export function FooterAction({ wide, controller }: FooterProps) {
  return <button className={css.footerButton} type="button" onClick={controller.open} aria-label="Open Agent Control">
    <span aria-hidden="true">⌘</span>{wide && <span>Agent Control</span>}
  </button>
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
  return <div className={css.error} role="alert"><span>{error}</span><button type="button" onClick={retry}>Retry</button></div>
}

function Overview({ data }: { data: RecordValue }) {
  const bridge = asRecord(data['bridge'])
  const workers = asArray(bridge['workers']).map(asRecord)
  const sessions = asArray(bridge['sessions']).map(asRecord)
  const counts = asRecord(data['counts'])
  const board = asRecord(data['board'])
  const columns = asArray(board['columns']).map(asRecord)
  return <div className={css.page}>
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

function Sessions({ snapshot, refresh, initialSessionId }: { snapshot: RecordValue; refresh(): Promise<void>; initialSessionId?: string | undefined }) {
  const bridge = asRecord(snapshot['bridge'])
  const sessions = asArray(bridge['sessions']).map(asRecord)
  const approvals = asArray(bridge['approvals']).map(asRecord)
  const inputs = asArray(bridge['userInput']).map(asRecord)
  const [selected, setSelected] = useState<RecordValue | undefined>(sessions.find(item => item['sessionId'] === initialSessionId) ?? sessions[0])
  const [events, setEvents] = useState<JsonValue[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(async (session: RecordValue) => {
    setSelected(session); setNotice('');
    try { const result = asRecord(await call('bridge', 'session_events', { sessionId: str(session['sessionId']), limit: 200 })); setEvents(asArray(result['data'])) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Failed to load events') }
  }, [])
  useEffect(() => {
    const target = sessions.find(item => item['sessionId'] === initialSessionId) ?? (initialSessionId ? undefined : sessions[0])
    if (target) void load(target)
  }, [initialSessionId])
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !message.trim() || busy) return
    setBusy(true); setNotice('')
    try {
      const args: RecordValue = { sessionId: str(selected['sessionId']), input: message.trim(), delivery: 'auto' }
      if (typeof selected['activeTurnId'] === 'string') args['expectedTurnId'] = selected['activeTurnId']
      const result = asRecord(await call('bridge', 'submit_turn', args))
      setNotice(`Accepted: ${str(result['resolvedAction'], str(result['status']))}`); setMessage(''); await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Send failed') } finally { setBusy(false) }
  }
  const interrupt = async () => {
    if (!selected || busy) return; setBusy(true)
    try { await call('bridge', 'interrupt_turn', { sessionId: str(selected['sessionId']), ...(typeof selected['activeTurnId'] === 'string' ? { expectedTurnId: selected['activeTurnId'] } : {}) }); setNotice('Interrupt accepted.'); await refresh() }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Interrupt failed') } finally { setBusy(false) }
  }
  return <div className={css.split}>
    <aside className={css.listPane}><div className={css.listHeading}>Sessions <span>{sessions.length}</span></div>{sessions.length === 0 ? <Empty>No sessions.</Empty> : sessions.map(session => <button className={`${css.sessionItem} ${selected?.['sessionId'] === session['sessionId'] ? css.selected : ''}`} key={str(session['sessionId'])} onClick={() => void load(session)} type="button">
      <span className={statusClass(str(session['status']))} /><span><strong>{sessionTitle(session)}</strong><small>{str(session['workerId'])}<br />{str(session['workspace'])}</small></span>
    </button>)}</aside>
    <main className={css.detailPane}>{!selected ? <Empty>Select a session.</Empty> : <>
      <header className={css.detailHeader}><div><h2>{sessionTitle(selected)}</h2><p>{str(selected['workspace'])} · {str(selected['workerId'])}</p></div><div className={css.headerActions}><span className={css.badge}>{str(selected['status'])}</span><button disabled={busy || !selected['activeTurnId']} onClick={() => void interrupt()} type="button">Interrupt</button></div></header>
      {approvals.filter(item => item['sessionId'] === selected['sessionId']).map(item => <PendingCard key={str(item['id'])} item={item} refresh={refresh} />)}
      {inputs.filter(item => item['sessionId'] === selected['sessionId']).map(item => <UserInputCard key={str(item['id'])} item={item} refresh={refresh} />)}
      <div className={css.timeline}>{events.length === 0 ? <Empty>No retained events, or the session has not been opened.</Empty> : events.map((event, index) => { const item = asRecord(event); return <article className={css.event} key={str(item['id'], String(index))}><div><span>{str(item['type'], 'event')}</span><time>{str(item['createdAt'], '')}</time></div><pre>{JSON.stringify(item['payload'] ?? item, null, 2)}</pre></article> })}</div>
      {notice && <div className={css.notice}>{notice}</div>}
      <form className={css.composer} onSubmit={event => void send(event)}><textarea value={message} onChange={event => setMessage(event.target.value)} placeholder={selected['status'] === 'active' ? 'Steer the active turn…' : 'Start a new turn…'} /><button disabled={busy || !message.trim()}>{busy ? 'Sending…' : 'Send'}</button></form>
    </>}</main>
  </div>
}

function PendingCard({ item, refresh }: { item: RecordValue; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const choices = asArray(item['choices']).filter((choice): choice is string => typeof choice === 'string')
  const decide = async (choice: string) => { setBusy(true); try { await call('bridge', 'resolve_approval', { approvalId: str(item['id']), choice }); await refresh() } finally { setBusy(false) } }
  return <div className={css.pending}><div><strong>Action required</strong><span>{str(item['summary'], str(item['kind']))}</span></div>{choices.map(choice => <button disabled={busy} key={choice} type="button" onClick={() => void decide(choice)}>{choice}</button>)}</div>
}

function UserInputCard({ item, refresh }: { item: RecordValue; refresh(): Promise<void> }) {
  const questions = asArray(item['questions']).map(asRecord)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const hasSecret = questions.some(question => question['isSecret'] === true)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (hasSecret) return
    const structured: RecordValue = {}
    for (const question of questions) structured[str(question['id'])] = { answers: [answers[str(question['id'])] ?? ''] }
    setBusy(true)
    try { await call('bridge', 'respond_user_input', { requestId: str(item['id']), answers: structured }); await refresh() }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Response failed') } finally { setBusy(false) }
  }
  return <form className={css.inputCard} onSubmit={event => void submit(event)}><strong>Agent needs input</strong>
    {questions.map(question => { const options = asArray(question['options']).map(asRecord); const key = str(question['id']); return <label key={key}><span>{str(question['header'])}: {str(question['question'])}</span>{question['isSecret'] === true ? <em>Secret input must be answered in the trusted local agent UI.</em> : options.length > 0 ? <select value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))}><option value="">Choose…</option>{options.map(option => <option key={str(option['label'])} value={str(option['label'])}>{str(option['label'])}</option>)}</select> : <input value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))} />}</label> })}
    {notice && <span>{notice}</span>}<button type="submit" disabled={busy || hasSecret || questions.some(question => !(answers[str(question['id'])] ?? '').trim())}>{busy ? 'Submitting…' : hasSecret ? 'Local handling required' : 'Submit answers'}</button>
  </form>
}

function Tasks({ snapshot, refresh, openSession }: { snapshot: RecordValue; refresh(): Promise<void>; openSession(sessionId: string): void }) {
  const board = asRecord(snapshot['board'])
  const bridgeSessions = asArray(asRecord(snapshot['bridge'])['sessions']).map(asRecord)
  const columns = asArray(board['columns']).map(asRecord)
  const assignees = asArray(board['assignees']).filter((item): item is string => typeof item === 'string')
  const [detail, setDetail] = useState<RecordValue>()
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const openTask = async (taskId: string) => { try { setDetail(asRecord(await call('kanban', 'show', { taskId }))); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Task load failed') } }
  return <div className={css.taskPage}>
    <div className={css.taskToolbar}><span>{columns.reduce((sum, column) => sum + asArray(column['tasks']).length, 0)} visible tasks</span><button type="button" onClick={() => setCreateOpen(true)}>Create task</button></div>
    {error && <div className={css.notice}>{error}</div>}
    <div className={css.board}>{columns.map(column => <section className={css.kanbanColumn} key={str(column['name'])}><header><span>{str(column['name'])}</span><strong>{asArray(column['tasks']).length}</strong></header>{asArray(column['tasks']).map(value => { const task = asRecord(value); return <button type="button" className={css.taskCard} key={str(task['id'])} onClick={() => void openTask(str(task['id']))}><strong>{str(task['title'])}</strong><small>{str(task['id'])}</small><footer><span>{str(task['assignee'], 'unassigned')}</span><span>P{str(task['priority'], '0')}</span></footer></button> })}</section>)}</div>
    {detail && <TaskDrawer data={detail} associatedSessions={bridgeSessions.filter(session => session['taskId'] === asRecord(detail['task'])['id'])} openSession={openSession} close={() => setDetail(undefined)} refresh={async () => { await refresh(); await openTask(str(asRecord(detail['task'])['id'])) }} />}
    {createOpen && <CreateTask assignees={assignees} busy={busy} close={() => setCreateOpen(false)} submit={async args => { setBusy(true); try { await call('kanban', 'create', args); setCreateOpen(false); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Create failed') } finally { setBusy(false) } }} />}
  </div>
}

function TaskDrawer({ data, associatedSessions, openSession, close, refresh }: { data: RecordValue; associatedSessions: RecordValue[]; openSession(sessionId: string): void; close(): void; refresh(): Promise<void> }) {
  const task = asRecord(data['task']); const comments = asArray(data['comments']).map(asRecord); const runs = asArray(data['runs']).map(asRecord); const links = asRecord(data['links'])
  const [comment, setComment] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('')
  const post = async (event: FormEvent) => { event.preventDefault(); if (!comment.trim()) return; setBusy(true); try { await call('kanban', 'comment', { taskId: str(task['id']), body: comment.trim() }); setComment(''); await refresh() } finally { setBusy(false) } }
  return <div className={css.drawerBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) close() }}><aside className={css.drawer}>
    <header><div><small>{str(task['id'])}</small><h2>{str(task['title'])}</h2></div><button type="button" onClick={close}>×</button></header>
    <div className={css.taskFacts}><span>{str(task['status'])}</span><span>{str(task['assignee'], 'unassigned')}</span><span>P{str(task['priority'], '0')}</span></div>
    <p className={css.body}>{str(task['body'], 'No description.')}</p>
    <div className={css.taskActions}>
      {(task['status'] === 'ready' || task['status'] === 'running') && <button type="button" disabled={busy} onClick={() => { const summary = window.prompt('Review handoff summary'); if (!summary?.trim()) return; setBusy(true); void call('kanban', 'request_review', { taskId: str(task['id']), summary: summary.trim(), force: false }).then(refresh).catch(error => setNotice(error instanceof Error ? error.message : 'Review request failed')).finally(() => setBusy(false)) }}>Request review</button>}
      {task['status'] === 'blocked' && <button type="button" disabled={busy} onClick={() => { setBusy(true); void call('kanban', 'unblock', { taskId: str(task['id']) }).then(refresh).catch(error => setNotice(error instanceof Error ? error.message : 'Unblock failed')).finally(() => setBusy(false)) }}>Unblock</button>}
    </div>
    {notice && <div className={css.notice}>{notice}</div>}
    {associatedSessions.length > 0 && <><h3>Agent Bridge sessions</h3>{associatedSessions.map(session => <button className={css.sessionLink} type="button" key={str(session['sessionId'])} onClick={() => openSession(str(session['sessionId']))}>{sessionTitle(session)} · {str(session['status'])}</button>)}</>}
    <h3>Dependencies</h3><p>Parents: {asArray(links['parents']).map(String).join(', ') || 'none'}<br />Children: {asArray(links['children']).map(String).join(', ') || 'none'}</p>
    <h3>Runs</h3>{runs.length === 0 ? <Empty>No runs.</Empty> : runs.map(run => <div className={css.run} key={str(run['id'])}><strong>Run {str(run['id'])}</strong><span>{str(run['outcome'], str(run['status']))}</span><p>{str(run['summary'], '')}</p></div>)}
    <h3>Comments</h3>{comments.map(item => <div className={css.comment} key={str(item['id'])}><strong>{str(item['author'])}</strong><p>{str(item['body'])}</p></div>)}
    <form className={css.commentForm} onSubmit={event => void post(event)}><textarea value={comment} onChange={event => setComment(event.target.value)} placeholder="Add a durable comment…" /><button disabled={busy || !comment.trim()}>Comment</button></form>
  </aside></div>
}

function CreateTask({ assignees, busy, close, submit }: { assignees: string[]; busy: boolean; close(): void; submit(args: RecordValue): Promise<void> }) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState(''); const [workspace, setWorkspace] = useState('')
  return <div className={css.drawerBackdrop}><form className={css.modal} onSubmit={event => { event.preventDefault(); void submit({ title: title.trim(), body, ...(assignee ? { assignee } : {}), workspaceKind: workspace ? 'dir' : 'scratch', ...(workspace ? { workspacePath: workspace } : {}), priority: 0, goalMode: false }) }}>
    <header><h2>Create task</h2><button type="button" onClick={close}>×</button></header>
    <label>Title<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>Description<textarea value={body} onChange={event => setBody(event.target.value)} /></label>
    <label>Assignee<select value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Unassigned</option>{assignees.map(name => <option key={name}>{name}</option>)}</select></label>
    <label>Workspace (optional absolute dir)<input value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>
    <button className={css.primary} disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create'}</button>
  </form></div>
}

function WorkspaceOverlay({ controller }: Injected) {
  const open = useController(controller)
  const [tab, setTab] = useState<'overview' | 'sessions' | 'tasks'>('overview')
  const [data, setData] = useState<RecordValue>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [linkedSession, setLinkedSession] = useState<string>()
  const refresh = useCallback(async () => { setLoading(true); try { setData(asRecord(await call('overview', 'snapshot'))); setError('') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent Control unavailable') } finally { setLoading(false) } }, [])
  useEffect(() => { if (open) void refresh() }, [open, refresh])
  useEffect(() => { if (!open) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') controller.close() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [controller, open])
  const content = useMemo(() => { if (!data) return null; if (tab === 'sessions') return <Sessions snapshot={data} refresh={refresh} initialSessionId={linkedSession} />; if (tab === 'tasks') return <Tasks snapshot={data} refresh={refresh} openSession={sessionId => { setLinkedSession(sessionId); setTab('sessions') }} />; return <Overview data={data} /> }, [data, linkedSession, refresh, tab])
  if (!open) return null
  return <div className={css.workspace} role="dialog" aria-modal="true" aria-label="Agent Control workspace">
    <header className={css.topbar}><div className={css.title}><span className={css.logo}>AC</span><div><strong>Agent Control</strong><small>Bridge sessions · Hermes tasks</small></div></div><nav>{(['overview', 'sessions', 'tasks'] as const).map(item => <button className={tab === item ? css.activeTab : ''} key={item} type="button" onClick={() => setTab(item)}>{item}</button>)}</nav><div className={css.topActions}><button type="button" onClick={() => void refresh()} disabled={loading}>↻</button><button type="button" onClick={controller.close}>Close</button></div></header>
    {error ? <ErrorBanner error={error} retry={() => void refresh()} /> : loading && !data ? <div className={css.loading}>Loading Agent Control…</div> : content}
  </div>
}

export const inject = ['slots', 'connection']
export function apply(ctx: ClientContext): void {
  connection = (ctx as unknown as { connection: RpcConnection }).connection
  const controller = new WorkspaceController()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-control', order: 20, inject: (): Injected => ({ controller }) }, FooterAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control', order: 10, inject: (): Injected => ({ controller }) }, WorkspaceOverlay))
}
