import { useEffect, useState, useSyncExternalStore } from 'react'
import { useDialog } from './dialog.js'
import css from './workspace.module.css'

export type ExecutionLocation = { workerId: string; workerName: string; machineId: string; machineName: string; workspace: string; online: boolean; available: boolean; local?: boolean }
export type NativeEntry = { nativeId: string; sessionId: string; workerId: string; model?: string; groupId: string; groupTitle: string; groupUpdatedAt: number; executionLocations: ExecutionLocation[]; machineId: string; workspace: string; projectIdentity?: string; presentationPath?: string; title: string; status: string; worker: string; updatedAt: number; lastUsedAt?: number }
export type WorkspaceRow = { workspaceId: string; path: string; title: string; sessionIds: readonly string[]; createdAt: string; updatedAt: string }
type WorkspaceSnapshot = { items: readonly WorkspaceRow[]; archivedSessionIds: readonly string[] }
type Source<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
export type WorkspaceHook = <T>(selector: (snapshot: WorkspaceSnapshot) => T) => T
type Workspaces = { list: Source<WorkspaceSnapshot>; rename(id: string, title: string): Promise<unknown>; delete(id: string): Promise<void>; insertSessionBefore(id: string, session: string, before?: string): Promise<unknown> }
type SessionSnapshot = { current?: string; byId?: Record<string, { updatedAt?: number }> }
export type CatalogSessions = { list: Source<SessionSnapshot>; clear(): void; refresh(): Promise<void> }
export const DELETE_SESSION_EVENT = 'agent-control:delete-session'
type Rpc = (operation: string, args?: Record<string, string | string[]>) => Promise<unknown>

const canonicalPath = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()

/** Adapt server-owned groups to DSH workspaces and only fuse path-matching local DSH sessions. */
export function mergeWorkspaces(rows: readonly WorkspaceRow[], catalog: readonly NativeEntry[], catalogReady = true, sessions: SessionSnapshot = {}): WorkspaceRow[] {
  // The Host workspace snapshot arrives before this client plugin can fetch the
  // Bridge catalog. Do not briefly expose every physical presentation workspace
  // while repository identities are still unknown. Native DSH sessions remain
  // visible; Bridge sessions appear once and already grouped after the first fetch.
  if (!catalogReady) return rows.flatMap(row => {
    const sessionIds = row.sessionIds.filter(id => !id.startsWith('agent-bridge-'))
    return sessionIds.length ? [{ ...row, sessionIds }] : []
  })
  const entries = new Map(catalog.map(entry => [entry.nativeId, entry]))
  const groups = new Map<string, NativeEntry[]>()
  for (const entry of catalog) { const values = groups.get(entry.groupId); if (values) values.push(entry); else groups.set(entry.groupId, [entry]) }
  const consumed = new Set<WorkspaceRow>()
  const result: WorkspaceRow[] = []
  const activity = new Map<WorkspaceRow, number>()
  const updatedAt = (id: string) => entries.get(id)?.updatedAt ?? sessions.byId?.[id]?.updatedAt ?? Number.NEGATIVE_INFINITY
  for (const members of groups.values()) {
    const ids = new Set(members.map(entry => entry.nativeId))
    const localPaths = new Set(members.flatMap(entry => entry.executionLocations).filter(location => location.local).map(location => canonicalPath(location.workspace)))
    const bridgeRows = rows.filter(row => row.sessionIds.some(id => ids.has(id)) || members.some(entry => entry.presentationPath === row.path))
    const localRows = rows.filter(row => localPaths.has(canonicalPath(row.path))
      && row.sessionIds.filter(id => entries.has(id)).every(id => ids.has(id)))
    const related = [...new Set([...bridgeRows, ...localRows])]
    const owner = localRows[0] ?? bridgeRows[0]
    if (!owner) continue
    for (const row of related) consumed.add(row)
    const bridgeIds = members.map(entry => entry.nativeId)
    const nativeIds = [...new Set(localRows.flatMap(row => row.sessionIds).filter(id => !entries.has(id)))]
      .sort((left, right) => updatedAt(right) - updatedAt(left))
    // The server already owns Bridge ordering. Merge local DSH rows into that
    // order by activity without independently re-sorting Bridge members.
    const sessionIds: string[] = []
    let bridgeIndex = 0, nativeIndex = 0
    while (bridgeIndex < bridgeIds.length || nativeIndex < nativeIds.length) {
      const bridge = bridgeIds[bridgeIndex], native = nativeIds[nativeIndex]
      if (native !== undefined && (bridge === undefined || updatedAt(native) > updatedAt(bridge))) { sessionIds.push(native); nativeIndex++ }
      else if (bridge !== undefined) { sessionIds.push(bridge); bridgeIndex++ }
    }
    const merged = { ...owner, title: members[0]!.groupTitle, sessionIds,
      updatedAt: new Date(Math.max(members[0]!.groupUpdatedAt, ...nativeIds.map(updatedAt))).toISOString() }
    result.push(merged)
    activity.set(merged, Math.max(members[0]!.groupUpdatedAt, ...nativeIds.map(updatedAt)))
  }
  for (const row of rows.filter(row => !consumed.has(row) && !row.sessionIds.some(id => entries.has(id)))) {
    const ordered = sessions.byId ? { ...row, sessionIds: [...row.sessionIds].sort((left, right) => updatedAt(right) - updatedAt(left)) } : row
    result.push(ordered)
    const latest = Math.max(...row.sessionIds.map(updatedAt))
    if (Number.isFinite(latest)) activity.set(ordered, latest)
  }
  // Server groups arrive newest-first. A stable activity sort preserves that
  // authority while allowing native-only or locally-fused directories to take
  // their correct place in the combined DSH list.
  return result.sort((left, right) => (activity.get(right) ?? Number.NEGATIVE_INFINITY) - (activity.get(left) ?? Number.NEGATIVE_INFINITY))
}

export class NativeCatalog {
  private entries: NativeEntry[] = []
  private loaded = false
  private readonly listeners = new Set<() => void>()
  private workspaceSource: Source<WorkspaceSnapshot> | undefined
  constructor(readonly rpc: Rpc, readonly sessions: CatalogSessions) {}
  snapshot = () => this.entries
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  entry(nativeId: string): NativeEntry | undefined { return this.entries.find(row => row.nativeId === nativeId) }
  useWorkspaces: WorkspaceHook = <T,>(selector: (snapshot: WorkspaceSnapshot) => T): T => {
    if (!this.workspaceSource) throw new Error('工作区目录尚未安装')
    const snapshot = useSyncExternalStore(this.workspaceSource.subscribe, this.workspaceSource.getSnapshot, this.workspaceSource.getSnapshot)
    return selector(snapshot)
  }
  private emit() { for (const listener of this.listeners) listener() }
  source(nativeId: string): { kind: 'bridge' | 'local'; worker: string; machine: string; workspace: string } | undefined {
    const entry = this.entries.find(row => row.nativeId === nativeId)
    if (entry) {
      const location = entry.executionLocations.find(value => value.machineId === entry.machineId && canonicalPath(value.workspace) === canonicalPath(entry.workspace))
      return { kind: 'bridge', worker: entry.worker, machine: location?.machineName ? `${location.machineName} (${entry.machineId})` : entry.machineId, workspace: entry.workspace }
    }
    const workspace = this.workspaceSource?.getSnapshot().items.find(row => row.sessionIds.includes(nativeId))
    return workspace ? { kind: 'local', worker: 'Local DSH', machine: '本机', workspace: workspace.path } : undefined
  }
  async refresh(): Promise<void> {
    const data = await this.rpc('native_catalog') as { sessions: NativeEntry[] }
    if (!Array.isArray(data.sessions)) throw new Error('会话目录不可用')
    if (!this.loaded || JSON.stringify(this.entries) !== JSON.stringify(data.sessions)) {
      this.loaded = true; this.entries = data.sessions; this.emit()
    }
  }
  async remove(entry: Pick<NativeEntry, 'nativeId'>): Promise<void> {
    const result = await this.rpc('delete_native', { nativeId: entry.nativeId }) as { deleted?: boolean }
    if (!result.deleted) throw new Error('尚未确认删除成功')
    if (this.sessions.list.getSnapshot().current === entry.nativeId) this.sessions.clear()
    this.entries = this.entries.filter(row => row.nativeId !== entry.nativeId); this.emit()
    await this.sessions.refresh()
  }
  install(workspaces: Workspaces): () => void {
    const source = workspaces.list
    const original = source.getSnapshot
    const subscribe = source.subscribe
    let raw: WorkspaceSnapshot | undefined, catalog: NativeEntry[] | undefined, sessionById: SessionSnapshot['byId'], cached: WorkspaceSnapshot
    const projected = () => {
      const next = original.call(source)
      const nextSessions = this.sessions.list.getSnapshot()
      if (next !== raw || catalog !== this.entries || sessionById !== nextSessions.byId) {
        raw = next; catalog = this.entries; sessionById = nextSessions.byId
        const current = new Set(this.entries.map(entry => entry.nativeId))
        cached = { ...next, items: mergeWorkspaces(next.items, this.entries, this.loaded, nextSessions), archivedSessionIds: next.archivedSessionIds.filter(id => !current.has(id)) }
      }
      return cached
    }
    const projectedSubscribe = (listener: () => void) => { const a = subscribe.call(source, listener); const b = this.subscribe(listener); const c = this.sessions.list.subscribe(listener); return () => { a(); b(); c() } }
    this.workspaceSource = { getSnapshot: projected, subscribe: projectedSubscribe }
    source.getSnapshot = projected
    source.subscribe = projectedSubscribe
    const rename = workspaces.rename, remove = workspaces.delete, move = workspaces.insertSessionBefore
    const originals = (id: string) => {
      const merged = projected().items.find(row => row.workspaceId === id)
      return original.call(source).items.filter(row => row.workspaceId === id || row.sessionIds.some(session => merged?.sessionIds.includes(session)))
    }
    workspaces.rename = async (id, title) => { let result: unknown; for (const row of originals(id)) result = await rename.call(workspaces, row.workspaceId, title); return result }
    workspaces.delete = async id => {
      const merged = projected().items.find(row => row.workspaceId === id)
      const physicalRows = originals(id)
      const nativeIds = merged?.sessionIds.filter(session => this.entries.some(entry => entry.nativeId === session)) ?? []
      if (nativeIds.length) {
        const result = await this.rpc('delete_native_workspace', { nativeIds }) as { deleted?: boolean }
        if (!result.deleted) throw new Error('尚未确认工作区内的 Bridge 会话已删除')
        if (nativeIds.includes(this.sessions.list.getSnapshot().current ?? '')) this.sessions.clear()
        const removed = new Set(nativeIds)
        this.entries = this.entries.filter(row => !removed.has(row.nativeId)); this.emit()
      }
      for (const row of physicalRows) await remove.call(workspaces, row.workspaceId)
      if (nativeIds.length) await this.sessions.refresh()
    }
    workspaces.insertSessionBefore = (id, session, before) => {
      const owner = originals(id).find(row => row.sessionIds.includes(session))
      return move.call(workspaces, owner?.workspaceId ?? id, session, before && owner?.sessionIds.includes(before) ? before : undefined)
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => { try { await this.refresh() } catch { /* retry transient Host startup/transport failures */ } finally { if (!disposed) timer = setTimeout(() => { void tick() }, 5000) } }
    void tick()
    return () => { disposed = true; clearTimeout(timer); this.workspaceSource = undefined; source.getSnapshot = original; source.subscribe = subscribe; workspaces.rename = rename; workspaces.delete = remove; workspaces.insertSessionBefore = move }
  }
}

export function sourceLabel(source: ReturnType<NativeCatalog['source']>): string {
  return source ? `${source.worker} · ${source.machine} · ${source.workspace}` : ''
}

export function SessionSourceMetadata({ catalog, sessionId }: { catalog: NativeCatalog; sessionId: string }) {
  useSyncExternalStore(catalog.subscribe, catalog.snapshot, catalog.snapshot)
  const label = sourceLabel(catalog.source(sessionId))
  return label ? <span className={css.sessionSource} title={label} data-session-source>{label}</span> : null
}

export function DeleteNativeSession({ catalog }: { catalog: NativeCatalog }) {
  const entries = useSyncExternalStore(catalog.subscribe, catalog.snapshot, catalog.snapshot)
  const [pending, setPending] = useState<NativeEntry>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ref = useDialog(!!pending, () => { if (!busy) setPending(undefined) })
  useEffect(() => {
    const request = (event: Event) => {
      const detail = (event as CustomEvent<{ nativeId: string; title: string }>).detail
      if (!detail || typeof detail.nativeId !== 'string' || busy) return
      setError(''); setPending(entries.find(row => row.nativeId === detail.nativeId) ?? { nativeId: detail.nativeId, sessionId: detail.nativeId.startsWith('agent-bridge-') ? '?' : '', workerId: '', groupId: '', groupTitle: '', groupUpdatedAt: 0, executionLocations: [], machineId: '', workspace: '', title: detail.title || 'DSH 对话', status: '', worker: 'DSH', updatedAt: 0 })
    }
    window.addEventListener(DELETE_SESSION_EVENT, request)
    return () => window.removeEventListener(DELETE_SESSION_EVENT, request)
  }, [entries, busy])
  return <>{pending && <div className={css.sourceOverlay}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-session-title" className={css.sourceDialog}>
      <h2 id="delete-session-title">删除此会话？</h2><p className={css.deleteTitle}>{pending.title}</p><p className={css.help}>{pending.worker}{pending.workspace ? ' · ' + pending.workspace : ''}</p>
      <p>{pending.sessionId ? '将删除 Bridge 中的会话并从客户端列表移除。' : '将删除此 DSH 对话的列表记录。底层日志保留以便恢复。'}工作目录和项目文件会保留。</p>
      {error && <p role="alert">{error}</p>}
      <footer className={css.dialogFooter}><button type="button" disabled={busy} onClick={() => setPending(undefined)}>取消</button><button type="button" className={css.dangerButton} disabled={busy} onClick={() => { setBusy(true); void catalog.remove(pending).then(() => setPending(undefined)).catch(cause => setError(cause instanceof Error ? cause.message : '删除失败')).finally(() => setBusy(false)) }}>{busy ? '正在删除…' : '确认删除'}</button></footer>
    </div></div>}</>
}
