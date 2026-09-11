import { useEffect, useState, useSyncExternalStore } from 'react'
import { useDialog } from './dialog.js'
import css from './workspace.module.css'

export type NativeEntry = { nativeId: string; sessionId: string; machineId: string; workspace: string; title: string; status: string; worker: string }
export type WorkspaceRow = { workspaceId: string; path: string; title: string; sessionIds: readonly string[]; createdAt: string; updatedAt: string }
type WorkspaceSnapshot = { items: readonly WorkspaceRow[]; archivedSessionIds: readonly string[] }
type Source<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
type Workspaces = { list: Source<WorkspaceSnapshot>; rename(id: string, title: string): Promise<unknown>; delete(id: string): Promise<void>; insertSessionBefore(id: string, session: string, before?: string): Promise<unknown> }
export type CatalogSessions = { list: Source<{ current?: string }>; clear(): void; refresh(): Promise<void> }
export const DELETE_SESSION_EVENT = 'agent-control:delete-session'
type Rpc = (operation: string, args?: Record<string, string>) => Promise<unknown>

/** Merge presentation accounts, keeping every original session/cwd and execution binding intact. */
export function mergeWorkspaces(rows: readonly WorkspaceRow[], catalog: readonly NativeEntry[]): WorkspaceRow[] {
  const entries = new Map(catalog.map(row => [row.nativeId, row]))
  const groups = new Map<string, WorkspaceRow>()
  const result: WorkspaceRow[] = []
  for (const row of rows) {
    const members = row.sessionIds.map(id => entries.get(id))
    const first = members.find(Boolean)
    const key = first ? first.machineId + '\0' + first.workspace : ''
    // Older presentation directories may also contain a blank native DSH session,
    // archived ids, or a deleted remote id. They must not veto known siblings.
    const presentation = /[\\/]\.dsh[\\/]agent-bridge[\\/]workspaces[\\/]/.test(row.path)
    if (!first || members.some(entry => entry ? entry.machineId + '\0' + entry.workspace !== key : !presentation)) { result.push(row); continue }
    const previous = groups.get(key)
    if (previous) {
      previous.sessionIds = [...new Set([...previous.sessionIds, ...row.sessionIds])]
      previous.updatedAt = previous.updatedAt > row.updatedAt ? previous.updatedAt : row.updatedAt
    } else {
      const basename = first.workspace.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? first.workspace
      const generated = row.title === basename || row.title.startsWith(basename + ' · ') || row.title === basename + ' @ ' + first.machineId
      const title = generated ? basename + ' @ ' + first.machineId : row.title
      const merged = { ...row, title, sessionIds: [...row.sessionIds] }
      groups.set(key, merged); result.push(merged)
    }
  }
  return result
}

export class NativeCatalog {
  private entries: NativeEntry[] = []
  private readonly listeners = new Set<() => void>()
  constructor(readonly rpc: Rpc, readonly sessions: CatalogSessions) {}
  snapshot = () => this.entries
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener() }
  async refresh(): Promise<void> {
    const data = await this.rpc('native_catalog') as { sessions: NativeEntry[] }
    if (!Array.isArray(data.sessions)) throw new Error('会话目录不可用')
    if (JSON.stringify(this.entries) !== JSON.stringify(data.sessions)) { this.entries = data.sessions; this.emit() }
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
    let raw: WorkspaceSnapshot | undefined, catalog: NativeEntry[] | undefined, cached: WorkspaceSnapshot
    const projected = () => {
      const next = original.call(source)
      if (next !== raw || catalog !== this.entries) {
        raw = next; catalog = this.entries
        cached = { ...next, items: mergeWorkspaces(next.items, this.entries) }
      }
      return cached
    }
    source.getSnapshot = projected
    source.subscribe = listener => { const a = subscribe.call(source, listener); const b = this.subscribe(listener); return () => { a(); b() } }
    const rename = workspaces.rename, remove = workspaces.delete, move = workspaces.insertSessionBefore
    const originals = (id: string) => {
      const merged = projected().items.find(row => row.workspaceId === id)
      return original.call(source).items.filter(row => row.workspaceId === id || row.sessionIds.some(session => merged?.sessionIds.includes(session)))
    }
    workspaces.rename = async (id, title) => { let result: unknown; for (const row of originals(id)) result = await rename.call(workspaces, row.workspaceId, title); return result }
    workspaces.delete = async id => { for (const row of originals(id)) await remove.call(workspaces, row.workspaceId) }
    workspaces.insertSessionBefore = (id, session, before) => {
      const owner = originals(id).find(row => row.sessionIds.includes(session))
      return move.call(workspaces, owner?.workspaceId ?? id, session, before && owner?.sessionIds.includes(before) ? before : undefined)
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => { try { await this.refresh() } catch { /* retry transient Host startup/transport failures */ } finally { if (!disposed) timer = setTimeout(() => { void tick() }, 5000) } }
    void tick()
    return () => { disposed = true; clearTimeout(timer); source.getSnapshot = original; source.subscribe = subscribe; workspaces.rename = rename; workspaces.delete = remove; workspaces.insertSessionBefore = move }
  }
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
      setError(''); setPending(entries.find(row => row.nativeId === detail.nativeId) ?? { nativeId: detail.nativeId, sessionId: detail.nativeId.startsWith('agent-bridge-') ? '?' : '', machineId: '', workspace: '', title: detail.title || 'DSH 对话', status: '', worker: 'DSH' })
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
