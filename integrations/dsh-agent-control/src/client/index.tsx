import { installSessionMenu } from './session-menu.js'
import { useDialog } from './dialog.js'
import { NativeCatalog, DeleteNativeSession, SessionSourceMetadata, sidebarDecor, type CatalogSessions } from './native-catalog.js'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './workspace.module.css'
import { openBridgeStream } from './bridge-stream.js'
import { ActivityStore } from './activity.js'
import { ActivityDock, ActivityTasksButton } from './activity-dock.js'

import { SessionStore, type BridgeRpc } from './session-store.js'
import { SessionCreationController, SessionSourcePicker, type CreationSessions, type CreationWorkspaces, type CreationNavigation } from './session-creation.js'
import { NativeModels, installBridgeModelDirectories } from './bridge-model-directory.js'


const RPC_CHANNEL = '/agent-control'
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type RecordValue = Record<string, JsonValue>

/** Management overlay only. DSH owns its session tree and conversation. */
export class WorkspaceController {
  readonly sessions: SessionStore
  error = ''
  private openValue = false
  private listeners = new Set<() => void>()
  constructor(private readonly rpc: BridgeRpc = (operation, args) => call('bridge', operation, args),
    loadNativeModelCatalog?: () => Promise<JsonValue>, private readonly openNative?: (id: string) => void) {
    this.sessions = new SessionStore(rpc, loadNativeModelCatalog, openBridgeStream)
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = (): boolean => this.openValue
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
  open = (): void => { this.openValue = true; this.sessions.activate(); this.emit() }
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
  </div>
}
function useController(controller: WorkspaceController): boolean {
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
}

type RpcConnection = { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: JsonValue; error?: { message?: string; code?: string } }> } }
let connection: RpcConnection | undefined
async function call(domain: 'overview' | 'bridge', operation: string, args?: RecordValue): Promise<JsonValue> {
  if (!connection) throw new Error('Agent Control connection is not ready')
  const envelope = await connection.rpc.call(RPC_CHANNEL, 'dispatch', { domain, operation, ...(args ? { args } : {}) })
  if (!envelope.ok) {
    const raw = envelope.error?.message ?? envelope.error?.code ?? 'Agent Control request failed'
    let message = raw
    try {
      const nested = JSON.parse(raw) as { error?: { message?: unknown } }
      if (typeof nested.error?.message === 'string') message = nested.error.message
    } catch { /* Connection may already provide a plain message. */ }
    throw new Error(message)
  }
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
const labels: Record<string, string> = { online:'在线', offline:'离线', active:'运行中', running:'运行中', idle:'空闲', waiting_for_approval:'待审批', waiting_for_input:'待回复', error:'异常', unknown:'未知' }
function statusLabel(value: JsonValue | undefined) { const name = str(value); return labels[name] ?? name }

function Empty({ children }: { children: ReactNode }) { return <div className={css.empty}>{children}</div> }
function ErrorBanner({ error, retry }: { error: string; retry(): void }) {
  return <div className={css.error} role="alert"><span>{error}</span><button type="button" onClick={retry}>重试</button></div>
}

function DeleteWorker({ worker, refresh }: { worker: RecordValue; refresh(): Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const ref = useDialog(open, () => { if (!busy) setOpen(false) })
  return <><button type="button" onClick={() => { setError(''); setOpen(true) }}>删除</button>{open && <div className={css.drawerBackdrop}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="删除离线 Worker" className={css.modal}>
    <h2>删除 {str(worker['name'])}？</h2><p>将移除此离线 worker 及其全部 {Number(worker['sessionCount'] ?? 0)} 个会话。历史消息、待处理请求也会清除，客户端会同步移除。项目文件保留。</p><p className={css.help}>同机器的其他 worker 不受影响。此 worker 重新连接后会重新显示，已删除的会话不会恢复。</p>
    {error && <p role="alert">{error}</p>}<footer className={css.dialogFooter}><button disabled={busy} onClick={() => setOpen(false)}>取消</button><button disabled={busy} onClick={() => { setBusy(true); void call('bridge', 'delete_worker', { workerId: str(worker['id']) }).then(async () => { setOpen(false); await refresh() }).catch(cause => setError(cause instanceof Error ? cause.message : '删除失败')).finally(() => setBusy(false)) }}>{busy ? '正在删除…' : '删除 Worker 和全部会话'}</button></footer>
  </div></div>}</>
}

export function Overview({ data, openSession, refresh = async () => {} }: { data: RecordValue; openSession(id: string): void; refresh?(): Promise<void> }) {
  const bridge = asRecord(data['bridge'])
  const workers = asArray(bridge['workers']).map(asRecord)
  const sessions = asArray(bridge['sessions']).map(asRecord)
  const counts = asRecord(data['counts'])
  const sessionProvider = asRecord(data['sessionProvider'])
  const [showOffline, setShowOffline] = useState(false)
  const visibleWorkers = workers.filter(worker => showOffline || worker['status'] === 'online').sort((a,b) => Number(b['status'] === 'online') - Number(a['status'] === 'online') || str(a['name']).localeCompare(str(b['name'])))
  return <div className={css.page}>
    <div className={css.pageHeading}><div><h2>运行概览</h2><p>查看机器连接与会话状态。</p></div><span className={css.syncSummary}>已同步 {Number(sessionProvider['nativeSessions'] ?? 0)} 个对话</span></div>
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
        {worker['status'] === 'offline' && <DeleteWorker worker={worker} refresh={refresh} />}
      </div>)}</section>
      <section className={css.panel}><h2>最近对话</h2>{sessions.length === 0 && <Empty>暂无对话</Empty>}{sessions.slice(0, 6).map(session => <button type="button" className={`${css.row} ${css.rowButton}`} key={str(session['sessionId'])} onClick={() => openSession(str(session['sessionId']))}>
        <span className={statusClass(str(session['status']))} />
        <div><strong>{sessionTitle(session)}</strong><small title={str(session['workspace'])}>{str(session['workspace'])}</small></div>
        <span className={css.rowMeta}>{statusLabel(session['status'])} ↗</span>
      </button>)}</section>
    </div>
  </div>
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className={`${css.metric} ${tone ? css[`tone_${tone}`] : ''}`}><span>{label}</span><strong>{value}</strong></div>
}

function WorkspaceOverlay({ controller, page = false }: Injected & { page?: boolean }) {
  const overlayOpen = useController(controller)
  const open = page || overlayOpen
  const ref = useDialog(!page && open, controller.close)
  const [data, setData] = useState<RecordValue>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestEpoch = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current
    setLoading(true)
    try {
      const result = asRecord(await call('overview', 'snapshot'))
      if (epoch !== requestEpoch.current) return
      setData(result); setError('')
    } catch (cause) { if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Agent Control unavailable') }
    finally { if (epoch === requestEpoch.current) setLoading(false) }
  }, [])
  useEffect(() => { if (open) void refresh(); return () => { requestEpoch.current++ } }, [open, refresh])
  const content = useMemo(() => data ? <Overview data={data} openSession={controller.openSession} refresh={refresh} /> : null, [data, refresh, controller])
  if (!open) return null
  return <div ref={ref} tabIndex={-1} className={`${css.workspace} ${page ? css.workspacePanel : ''}`} role={page ? 'region' : 'dialog'} aria-modal={page ? undefined : true} aria-label="Agent Control workspace" aria-busy={loading}>
    <header className={css.topbar}><div className={css.title}><span className={css.logo}>AC</span><div><strong>Agent 控制台</strong><small>机器与对话</small></div></div><div className={css.topActions}><button type="button" aria-label="Refresh Agent Control" onClick={() => void refresh()} disabled={loading}>{loading ? '刷新中…' : '↻ 刷新'}</button>{!page && <button type="button" onClick={controller.close}>关闭</button>}</div></header>
    {controller.error && <div className={css.error} role="alert">{controller.error}</div>}
    {error ? <ErrorBanner error={error} retry={() => void refresh()} /> : !data ? <div role="status" className={css.loading}>正在加载…</div> : content}
  </div>
}

export function ControlPanelIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9l3 2-3 2M13 13h4" /></svg>
}

export const inject = ['slots', 'connection', 'layout', 'remote', 'remote.session', 'sessions', 'workspaces', 'uiWorkspace', 'modelDirectories']
export function apply(ctx: ClientContext): void {
  connection = (ctx as unknown as { connection: RpcConnection }).connection
  const remote = (ctx as unknown as { remote: { session: {
    modelCatalog(): Promise<{ ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } }>
    selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ ok: boolean; error?: { code?: string; message?: string } }>
  }; $on(event: string, listener: () => void): () => void } }).remote
  const nativeSessions = (ctx as unknown as { get(name: string): unknown }).get('sessions') as unknown as { open(id: string): void } | undefined
  const creation = new SessionCreationController((operation, args) => call('bridge', operation, args))
  const catalog = new NativeCatalog((operation, args) => call('bridge', operation, args), ctx.get('sessions') as unknown as CatalogSessions)
  const loadNativeModelCatalog = async (): Promise<JsonValue> => {
    const response = await remote.session.modelCatalog()
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.value
  }
  const nativeModels = new NativeModels((operation, args) => call('bridge', operation, args))
  const modelDirectories = (ctx as unknown as { get(name: string): unknown }).get('modelDirectories') as Parameters<typeof installBridgeModelDirectories>[0] | undefined
  if (modelDirectories) ctx.effect(() => installBridgeModelDirectories(modelDirectories, catalog,
    nativeModels, request => remote.session.selectModel(request)))
  ctx.effect(() => catalog.install(ctx.get('workspaces') as unknown as Parameters<NativeCatalog['install']>[0]))
  // TokensCowork creates its root workspace hook before third-party plugins load.
  // Override that captured hook on the native slot while retaining its component.
  ctx.effect(() => installSessionMenu(ctx.slots, catalog.useWorkspaces, sidebarDecor(catalog), catalog.activity))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'agent-control-session-source-metadata', order: 5,
    inject: (sessionId: string) => ({ catalog, sessionId }),
  }, SessionSourceMetadata))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control-delete-session', order: 12, inject: () => ({ catalog }) }, DeleteNativeSession))
  // What a remote session is doing right now, above the composer and in the header.
  const activity = new ActivityStore((operation, args) => call('bridge', operation, args), openBridgeStream)
  ctx.effect(() => () => activity.dispose())
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'agent-control-remote-activity', order: 10,
    inject: (sessionId: string) => ({ store: activity, catalog, sessionId }),
  }, ActivityDock))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'agent-control-remote-tasks', order: 5,
    inject: (sessionId: string) => ({ store: activity, catalog, sessionId }),
  }, ActivityTasksButton))
  ctx.effect(() => {
    let disposed = false
    let uninstall: (() => void) | undefined
    // Resolve sources at click time; Host startup must not permanently disable interception.
    if (!disposed) uninstall = creation.install(ctx.get('sessions') as unknown as CreationSessions, ctx.get('workspaces') as unknown as CreationWorkspaces, ctx.get('uiWorkspace') as unknown as CreationNavigation)
    return () => { disposed = true; uninstall?.() }
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control-session-source', order: 11, inject: () => ({ controller: creation }) }, SessionSourcePicker))
  const controller = new WorkspaceController(undefined, loadNativeModelCatalog, id => nativeSessions?.open(id))
  ctx.effect(() => {
    const refresh = () => { nativeModels.invalidate(); controller.sessions.invalidateModels() }
    const disposers = [remote.$on('llm/adapters-updated', refresh), remote.$on('settings/document-updated', refresh), remote.$on('credentials/reference-updated', refresh)]
    return () => { for (const dispose of disposers) dispose(); controller.sessions.dispose() }
  })
  // Use the shell's native navigation row, immediately after Automations.
  const panelSlots = ctx.slots as unknown as {
    spec(name: string): unknown
    inject(name: string, callback: () => () => void): void
    register(options: { name: string; id?: string; key?: string; order?: number; label?: string; inject?: () => unknown }, component: unknown): () => void
  }
  if (panelSlots.spec('main')) {
    panelSlots.inject('sidebar.panellist', () => panelSlots.register({ name: 'sidebar.panellist', id: 'agent-control', order: 20, label: 'Agent 控制台' }, ControlPanelIcon))
    panelSlots.inject('main', () => panelSlots.register({ name: 'main', key: 'agent-control', inject: () => ({ controller, page: true }) }, WorkspaceOverlay))
  } else ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-control', order: 20, inject: (): Injected => ({ controller }) }, FooterAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-control', order: 10, inject: (): Injected => ({ controller }) }, WorkspaceOverlay))
}
