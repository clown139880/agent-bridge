import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useDialog } from './dialog.js'
import { AGENT_LABELS, AgentIcon, MachineChip, agentKind } from './agent-identity.js'
import type { SidebarDecor } from './session-menu.js'
import css from './workspace.module.css'
import { isVirtualSession } from '../remote-sessions/id.js'
import { READ_ONLY } from './remote-sessions.js'

export type ExecutionLocation = { workerId: string; workerName: string; agent?: string; machineId: string; machineName: string; workspace: string; online: boolean; available: boolean; local?: boolean }
export type NativeEntry = { nativeId: string; sessionId: string; workerId: string; model?: string; groupId: string; groupTitle: string; groupUpdatedAt: number; executionLocations: ExecutionLocation[]; machineId: string; workspace: string; projectIdentity?: string; presentationPath?: string; title: string; status: string; worker: string; updatedAt: number; activityAt: number; lastUsedAt?: number; automation?: string }
export type WorkspaceRow = { workspaceId: string; sourceWorkspaceId?: string; path: string; title: string; sessionIds: readonly string[]; createdAt: string; updatedAt: string }
type WorkspaceSnapshot = { items: readonly WorkspaceRow[]; archivedSessionIds: readonly string[] }
type Source<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
export type WorkspaceHook = <T>(selector: (snapshot: WorkspaceSnapshot) => T) => T
type Workspaces = { list: Source<WorkspaceSnapshot>; rename(id: string, title: string): Promise<unknown>; delete(id: string): Promise<void>; insertSessionBefore(id: string, session: string, before?: string): Promise<unknown> }
type SessionSnapshot = { current?: string; byId?: Record<string, { updatedAt?: number }> }
export type CatalogSessions = { list: Source<SessionSnapshot>; clear(): void; refresh(): Promise<void> }
export const DELETE_SESSION_EVENT = 'agent-control:delete-session'
export const RETITLE_SESSION_EVENT = 'agent-control:retitle-session'
type Rpc = (operation: string, args?: Record<string, string | number | string[]>) => Promise<unknown>

const EMPTY_SNAPSHOT: WorkspaceSnapshot = { items: [], archivedSessionIds: [] }
const EMPTY_WORKSPACES: Source<WorkspaceSnapshot> = { getSnapshot: () => EMPTY_SNAPSHOT, subscribe: () => () => {} }
/** Sidebar id of a server group that shares its physical workspace with another group. */
const SPLIT_GROUP_PREFIX = 'agent-bridge-group:'

const canonicalPath =(value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()
/** Bridge sessions the sidebar lists, as the Control Center's list does. */
export const LISTED_LIMIT = 50
const RUNNING = new Set(['creating', 'active', 'waiting_for_approval', 'waiting_for_input'])

/** The Bridge sessions DSH lists: the most recently prompted ones without automation
 * runs, as in the Control Center, plus every running or waiting one. DSH renders
 * every listed row on each change, so older sessions stay in the Control Center.
 * Drafts have no Bridge session yet and are always listed. */
export function listedEntries(catalog: readonly NativeEntry[], limit = LISTED_LIMIT): NativeEntry[] {
  const recent = new Set(catalog.filter(entry => isVirtualSession(entry.nativeId) && !entry.automation)
    .sort((left, right) => right.activityAt - left.activityAt).slice(0, limit))
  return catalog.filter(entry => !isVirtualSession(entry.nativeId) || recent.has(entry) || !entry.automation && RUNNING.has(entry.status))
}

/** Sidebar recency of one row. Bridge sessions use the catalog's last-prompt
 * time: DSH stamps imported prompts with their sync time, so its own
 * `updatedAt` is not a real activity time for them. Local DSH sessions keep it. */
export function sessionActivity(id: string, entries: ReadonlyMap<string, Pick<NativeEntry, 'activityAt'>>, sessions: SessionSnapshot = {}): number {
  return entries.get(id)?.activityAt ?? sessions.byId?.[id]?.updatedAt ?? Number.NEGATIVE_INFINITY
}

/** `next`, or `previous` when it holds the same ids in the same order. */
export function sameIds(previous: readonly string[] | undefined, next: readonly string[]): readonly string[] {
  return previous && previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next
}
const sameRow = (previous: WorkspaceRow, next: WorkspaceRow): boolean => {
  const keys = Object.keys(next) as (keyof WorkspaceRow)[]
  return keys.length === Object.keys(previous).length
    && keys.every(key => key === 'sessionIds' ? sameIds(previous.sessionIds, next.sessionIds) === previous.sessionIds : previous[key] === next[key])
}
/** `next` with every unchanged row (by workspace id) kept as before; `previous` itself when nothing changed. */
export function sameRows(previous: readonly WorkspaceRow[] | undefined, next: readonly WorkspaceRow[]): readonly WorkspaceRow[] {
  if (!previous) return next
  const before = new Map(previous.map(row => [row.workspaceId, row]))
  const rows = next.map(row => { const old = before.get(row.workspaceId); return old && sameRow(old, row) ? old : row })
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows
}

/** Adapt server-owned groups to DSH workspaces and only fuse path-matching local DSH sessions.
 * `listed` (default: all) are the catalog ids the sidebar shows; a group with none of
 * them and no fused local session still owns its rows but is not shown. */
export function mergeWorkspaces(rows: readonly WorkspaceRow[], catalog: readonly NativeEntry[], catalogReady = true, sessions: SessionSnapshot = {}, listed?: ReadonlySet<string>): WorkspaceRow[] {
  // The Host workspace snapshot arrives before this client plugin can fetch the
  // Bridge catalog. Do not briefly expose every physical presentation workspace
  // while repository identities are still unknown. Native DSH sessions remain
  // visible; Bridge sessions appear once and already grouped after the first fetch.
  if (!catalogReady) return rows.flatMap(row => {
    const sessionIds = row.sessionIds.filter(id => !id.startsWith('agent-bridge-'))
    return sessionIds.length ? [{ ...row, sessionIds }] : []
  })
  const entries = new Map(catalog.map(entry => [entry.nativeId, entry]))
  const imported = new Set(catalog.map(entry => (entry as NativeEntry & { importedId?: string }).importedId).filter(Boolean))
  // A Bridge id the loaded catalog no longer lists was deleted; its host row can
  // linger until archival lands and must not resurface as a local DSH session.
  const isBridgeId = (id: string) => imported.has(id) || id.startsWith('agent-bridge-') && !entries.has(id)
  const groups = new Map<string, NativeEntry[]>()
  for (const entry of catalog) { const values = groups.get(entry.groupId); if (values) values.push(entry); else groups.set(entry.groupId, [entry]) }
  const consumed = new Set<WorkspaceRow>()
  const result: WorkspaceRow[] = []
  const activity = new Map<WorkspaceRow, number>()
  const updatedAt = (id: string) => sessionActivity(id, entries, sessions)
  const newestFirst = (left: string, right: string) => updatedAt(right) - updatedAt(left)
  // Rows are assigned in a stable group order, never the activity-ranked catalog
  // order: which group fuses a shared directory's native sessions and which ids
  // it shows must not flip each time another group becomes the most recent.
  const assigned = new Map<string, { owner: WorkspaceRow; members: NativeEntry[]; sessionIds: string[]; latest: number }>()
  for (const [groupId, members] of [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const ids = new Set(members.map(entry => entry.nativeId))
    const localPaths = new Set(members.flatMap(entry => entry.executionLocations).filter(location => location.local).map(location => canonicalPath(location.workspace)))
    const bridgeRows = rows.filter(row => row.sessionIds.some(id => ids.has(id)) || members.some(entry => entry.presentationPath === row.path))
    const localRows = rows.filter(row => !consumed.has(row) && localPaths.has(canonicalPath(row.path))
      && row.sessionIds.filter(id => entries.has(id)).every(id => ids.has(id)))
    const related = [...new Set([...bridgeRows, ...localRows])]
    const owner = localRows[0] ?? bridgeRows.find(row => !consumed.has(row)) ?? bridgeRows[0] ?? (members.some(entry => isVirtualSession(entry.nativeId)) ? {
      workspaceId: `bridge-remote-workspace-${members[0]!.nativeId}`, path: members[0]!.workspace,
      title: members[0]!.groupTitle, sessionIds: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(members[0]!.updatedAt || 0).toISOString(),
    } : undefined)
    if (!owner) continue
    for (const row of related) consumed.add(row)
    const nativeIds = [...new Set(localRows.flatMap(row => row.sessionIds).filter(id => !entries.has(id) && !isBridgeId(id)))]
    // One clock for every member: never trust the arrival order, which can lag
    // behind the activity it was derived from. The sort is stable for ties.
    const sessionIds = [...members.map(entry => entry.nativeId).filter(id => !listed || listed.has(id)), ...nativeIds].sort(newestFirst)
    assigned.set(groupId, { owner, members, sessionIds, latest: Math.max(...sessionIds.map(updatedAt)) })
  }
  const owners = new Map<string, number>()
  for (const { owner } of assigned.values()) owners.set(owner.workspaceId, (owners.get(owner.workspaceId) ?? 0) + 1)
  // Emitted in catalog order so equal activity keeps the server's order.
  for (const groupId of groups.keys()) {
    if (!assigned.has(groupId)) continue
    const { owner, members, sessionIds, latest } = assigned.get(groupId)!
    // Counted among the owners above all the same, so a shown group keeps its id.
    if (!sessionIds.length) continue
    // Separate server groups may share one physical workspace. Each needs its own
    // order account and React key, and none may borrow the physical id: whichever
    // did would hand it, its persisted order and its view state to the others.
    const shared = owners.get(owner.workspaceId)! > 1
    const merged = { ...owner, ...(shared ? { workspaceId: `${SPLIT_GROUP_PREFIX}${members[0]!.groupId}`, sourceWorkspaceId: owner.workspaceId } : {}),
      title: members[0]!.groupTitle, sessionIds, updatedAt: Number.isFinite(latest) ? new Date(latest).toISOString() : owner.updatedAt }
    result.push(merged)
    activity.set(merged, latest)
  }
  // A real local directory whose Bridge sessions belong to different groups fuses
  // its native DSH sessions into none of them; they keep their own row (and the
  // physical id) instead of vanishing with the consumed row. Presentation folders
  // are not local directories, so their stale native blanks stay hidden.
  const placed = new Set(result.flatMap(row => row.sessionIds))
  const localDirectories = new Set(catalog.flatMap(entry => entry.executionLocations).filter(location => location.local).map(location => canonicalPath(location.workspace)))
  for (const source of rows.filter(row => consumed.has(row) && localDirectories.has(canonicalPath(row.path)))) {
    const native = source.sessionIds.filter(id => !entries.has(id) && !isBridgeId(id) && !placed.has(id))
    if (!native.length) continue
    for (const id of native) placed.add(id)
    const row = { ...source, sessionIds: sessions.byId ? native.sort(newestFirst) : native }
    result.push(row)
    const latest = Math.max(...native.map(updatedAt))
    if (Number.isFinite(latest)) activity.set(row, latest)
  }
  for (const source of rows.filter(row => !consumed.has(row) && !row.sessionIds.some(id => entries.has(id)))) {
    const row = source.sessionIds.some(isBridgeId) ? { ...source, sessionIds: source.sessionIds.filter(id => !isBridgeId(id)) } : source
    if (!row.sessionIds.length && source.sessionIds.length) continue
    const ordered = sessions.byId ? { ...row, sessionIds: [...row.sessionIds].sort(newestFirst) } : row
    result.push(ordered)
    const latest = Math.max(...row.sessionIds.map(updatedAt))
    if (Number.isFinite(latest)) activity.set(ordered, latest)
  }
  // A group ranks by its newest member on the same clock as the rows inside it.
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
  private activityCache: { entries: NativeEntry[]; value: ReadonlyMap<string, number> } | undefined
  /** Bridge session recency by native id; one Map identity per catalog snapshot. */
  activity = (): ReadonlyMap<string, number> => {
    if (this.activityCache?.entries !== this.entries) this.activityCache = { entries: this.entries, value: new Map(this.entries.map(entry => [entry.nativeId, entry.activityAt])) }
    return this.activityCache.value
  }
  private listedCache: { entries: NativeEntry[]; value: NativeEntry[]; ids: ReadonlySet<string> } | undefined
  private listedState() {
    if (this.listedCache?.entries !== this.entries) {
      const value = listedEntries(this.entries)
      this.listedCache = { entries: this.entries, value, ids: new Set(value.map(entry => entry.nativeId)) }
    }
    return this.listedCache
  }
  /** The entries DSH lists (see `listedEntries`); one array identity per catalog snapshot. */
  listed = (): NativeEntry[] => this.listedState().value
  /** Never throws: a hot reload disposes this plugin while DSH may still render
   * its patched sidebar, and a throw there crashes the slot into a blank list. */
  useWorkspaces: WorkspaceHook =<T,>(selector: (snapshot: WorkspaceSnapshot) => T): T => {
    const source = this.workspaceSource ?? EMPTY_WORKSPACES
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
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
  private location(entry: NativeEntry): ExecutionLocation | undefined {
    return entry.executionLocations.find(value => value.workerId === entry.workerId)
      ?? entry.executionLocations.find(value => value.machineId === entry.machineId)
  }
  /** Agent and machine of a sidebar row; ids the catalog does not list are Host-native DSH sessions. */
  identity(nativeId: string): { agent: ReturnType<typeof agentKind>; label: string } | undefined {
    const entry = this.entry(nativeId)
    if (!entry) return nativeId.startsWith('agent-bridge-') ? undefined : { agent: 'dsh', label: 'DSH · 本机' }
    const location = this.location(entry)
    const agent = agentKind({ workerId: entry.workerId, agentType: location?.agent, name: entry.worker })
    return { agent, label: `${agent ? AGENT_LABELS[agent] : entry.worker} · ${location?.machineName || entry.machineId}` }
  }
  /** Distinct machines the Bridge sessions of one (merged) sidebar workspace run on. */
  machines(workspaceId: string): { machineId: string; machineName: string }[] {
    const row = this.workspaceSource?.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    const machines = new Map<string, string>()
    for (const id of row?.sessionIds ?? []) {
      const entry = this.entry(id)
      if (entry && !machines.has(entry.machineId)) machines.set(entry.machineId, this.location(entry)?.machineName || entry.machineId)
    }
    return [...machines].map(([machineId, machineName]) => ({ machineId, machineName }))
  }
  private position = { epoch: '', rev: 0 }
  /** Applies the changes since the last revision; the whole catalog only on the first call or a Host restart. */
  async refresh(): Promise<void> {
    const data = await this.rpc('native_catalog', { since: this.position.rev, epoch: this.position.epoch }) as
      { sessions: NativeEntry[]; removed?: string[]; order?: string[]; full?: boolean; epoch?: string; rev?: number }
    if (!Array.isArray(data.sessions)) throw new Error('会话目录不可用')
    // Hosts before 0.4.3 always answer with the whole catalog and no revision.
    const whole = data.full !== false || typeof data.rev !== 'number'
    if (!whole && !data.sessions.length && !data.removed?.length && !data.order) { this.position.rev = data.rev!; return }
    const byId = new Map((whole ? [] : this.entries).map(row => [row.nativeId, row]))
    for (const id of data.removed ?? []) byId.delete(id)
    for (const row of data.sessions) byId.set(row.nativeId, row)
    const order = data.order ?? (whole ? data.sessions.map(row => row.nativeId) : this.entries.map(row => row.nativeId).concat(data.sessions.map(row => row.nativeId)))
    const next = [...new Set(order)].map(id => byId.get(id)).filter((row): row is NativeEntry => !!row)
    if (typeof data.rev === 'number') this.position = { epoch: data.epoch ?? '', rev: data.rev }
    this.loaded = true; this.entries = next; this.emit()
  }
  /** Name a Bridge session again from its latest conversation; the list shows it on the next catalog change. */
  async retitle(nativeId: string): Promise<void> {
    if (isVirtualSession(nativeId)) throw new Error(READ_ONLY)
    await this.rpc('retitle_native', { nativeId })
    await this.sessions.refresh()
  }
  async remove(entry: Pick<NativeEntry, 'nativeId'>): Promise<void> {
    if (isVirtualSession(entry.nativeId)) throw new Error(READ_ONLY)
    const result = await this.rpc('delete_native', { nativeId: entry.nativeId }) as { deleted?: boolean }
    if (!result.deleted) throw new Error('尚未确认删除成功')
    // No sessions.clear(): it persists DSH's explicit "no session selected" mode.
    // The deletion archives the row, and DSH clears an archived current itself.
    this.entries = this.entries.filter(row => row.nativeId !== entry.nativeId); this.emit()
    await this.sessions.refresh()
  }
  install(workspaces: Workspaces): () => void {
    const source = workspaces.list
    const original = source.getSnapshot
    const subscribe = source.subscribe
    let raw: WorkspaceSnapshot | undefined, catalog: NativeEntry[] | undefined, sessionById: SessionSnapshot['byId'], cached: WorkspaceSnapshot | undefined
    const projected = () => {
      const next = original.call(source)
      const nextSessions = this.sessions.list.getSnapshot()
      if (next !== raw || catalog !== this.entries || sessionById !== nextSessions.byId) {
        raw = next; catalog = this.entries; sessionById = nextSessions.byId
        const current = new Set(this.entries.map(entry => entry.nativeId))
        // DSH rebuilds its session list on every change, unchanged or not. Keep the
        // previous rows when they come out the same, or the sidebar renders again.
        const items = sameRows(cached?.items, mergeWorkspaces(next.items, this.entries, this.loaded, nextSessions, this.listedState().ids))
        const archivedSessionIds = sameIds(cached?.archivedSessionIds, next.archivedSessionIds.filter(id => !current.has(id)))
        const rest = (snapshot: WorkspaceSnapshot) => Object.entries(snapshot).filter(([key]) => key !== 'items' && key !== 'archivedSessionIds')
        const unchanged = !!cached && items === cached.items && archivedSessionIds === cached.archivedSessionIds
          && rest(next).every(([key, value]) => (cached as Record<string, unknown>)[key] === value) && rest(cached).length === rest(next).length
        if (!unchanged) cached = { ...next, items, archivedSessionIds }
      }
      return cached!
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
    // A physical row another sidebar row still shows (as its own source, or by
    // listing its sessions) belongs to that row too: never rename or delete it
    // on behalf of just one of them.
    const exclusive = (id: string) => {
      const others = projected().items.filter(row => row.workspaceId !== id)
      return originals(id).filter(row => !others.some(other => (other.sourceWorkspaceId ?? other.workspaceId) === row.workspaceId
        || other.sessionIds.some(session => row.sessionIds.includes(session))))
    }
    workspaces.rename = async (id, title) => {
      if (projected().items.find(row => row.workspaceId === id)?.sessionIds.some(isVirtualSession)) throw new Error(READ_ONLY)
      const rows = exclusive(id)
      if (!rows.length && originals(id).length) throw new Error('该分组与其他分组共用同一目录，不能单独重命名')
      let result: unknown; for (const row of rows) result = await rename.call(workspaces, row.workspaceId, title); return result
    }
    workspaces.delete = async id => {
      const merged = projected().items.find(row => row.workspaceId === id)
      if (merged?.sessionIds.some(isVirtualSession)) throw new Error(READ_ONLY)
      const physicalRows = exclusive(id)
      const nativeIds = merged?.sessionIds.filter(session => this.entries.some(entry => entry.nativeId === session)) ?? []
      if (!nativeIds.length && !physicalRows.length && originals(id).length) throw new Error('该目录仍被其他分组使用，不能单独删除')
      if (nativeIds.length) {
        const result = await this.rpc('delete_native_workspace', { nativeIds }) as { deleted?: boolean }
        if (!result.deleted) throw new Error('尚未确认工作区内的 Bridge 会话已删除')
      }
      for (const row of physicalRows) await remove.call(workspaces, row.workspaceId)
      if (nativeIds.length) {
        const removed = new Set(nativeIds)
        this.entries = this.entries.filter(row => !removed.has(row.nativeId)); this.emit()
        // Workspace deletion already removes the current row through the native
        // Session/Workspace feeds. Calling sessions.clear() here would persist
        // DSH's explicit "no session selected" mode and blank the whole sidebar.
        await this.sessions.refresh()
      }
    }
    workspaces.insertSessionBefore = (id, session, before) => {
      if (isVirtualSession(session) || isVirtualSession(before)) return Promise.reject(new Error(READ_ONLY))
      const owner = originals(id).find(row => row.sessionIds.includes(session))
      return move.call(workspaces, owner?.workspaceId ?? id, session, before && owner?.sessionIds.includes(before) ? before : undefined)
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => { try { await this.refresh() } catch { /* retry transient Host startup/transport failures */ } finally { if (!disposed) timer = setTimeout(() => { void tick() }, 5000) } }
    void tick()
    // Keep serving DSH's own rows until the reloaded plugin installs again.
    return () => { disposed = true; clearTimeout(timer); this.workspaceSource = { getSnapshot: () => original.call(source), subscribe: listener => subscribe.call(source, listener) }; source.getSnapshot = original; source.subscribe = subscribe; workspaces.rename = rename; workspaces.delete = remove; workspaces.insertSessionBefore = move }
  }
}

/** Sidebar identity: a brand icon per session row and a machine chip per workspace,
 * replacing the server's `name @ machine` suffix so every workspace reads the same way. */
export function sidebarDecor(catalog: NativeCatalog): SidebarDecor {
  return {
    session(id) {
      const identity = catalog.identity(id)
      return identity ? <span className={css.sidebarAgent}><AgentIcon agent={identity.agent} size={14} title={identity.label} /></span> : null
    },
    workspace(workspaceId, label): ReactNode {
      const machines = catalog.machines(workspaceId)
      if (!machines.length) return undefined
      const suffix = machines.flatMap(machine => [machine.machineId, machine.machineName]).find(name => label.endsWith(' @ ' + name))
      const name = suffix ? label.slice(0, -(' @ ' + suffix).length) : label
      const chip = machines.length === 1
        ? <MachineChip machineId={machines[0]!.machineId} label={machines[0]!.machineName} title={`${machines[0]!.machineName} (${machines[0]!.machineId})`} />
        : <MachineChip machineId="" label={`${machines.length} 台机器`} title={machines.map(machine => machine.machineName).join('、')} />
      return <span className={css.sidebarLabel}><span className={css.sidebarName}>{name}</span>{chip}</span>
    },
  }
}

export function sourceLabel(source: ReturnType<NativeCatalog['source']>): string {
  return source ? `${source.worker} · ${source.machine} · ${source.workspace}` : ''
}

/** Compact session metadata used beside the conversation header. Keep the last
 * known model visible even when the worker is temporarily offline. */
export function sessionModelLabel(entry: Pick<NativeEntry, 'model'> | undefined): string {
  const model = entry?.model?.trim()
  return model ? `模型：${model}` : ''
}

export function SessionSourceMetadata({ catalog, sessionId }: { catalog: NativeCatalog; sessionId: string }) {
  useSyncExternalStore(catalog.subscribe, catalog.snapshot, catalog.snapshot)
  const entry = catalog.entry(sessionId)
  const source = sourceLabel(catalog.source(sessionId))
  const model = sessionModelLabel(entry)
  const label = [source, model].filter(Boolean).join(' · ')
  return label ? <span className={css.sessionSource} title={label} data-session-source>{label}</span> : null
}

export function DeleteNativeSession({ catalog }: { catalog: NativeCatalog }) {
  const entries = useSyncExternalStore(catalog.subscribe, catalog.snapshot, catalog.snapshot)
  const [pending, setPending] = useState<NativeEntry>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retitleError, setRetitleError] = useState('')
  useEffect(() => { if (!retitleError) return; const timer = setTimeout(() => setRetitleError(''), 6_000); return () => clearTimeout(timer) }, [retitleError])
  const ref = useDialog(!!pending, () => { if (!busy) setPending(undefined) })
  useEffect(() => {
    const request = (event: Event) => {
      const detail = (event as CustomEvent<{ nativeId: string; title: string }>).detail
      if (!detail || typeof detail.nativeId !== 'string' || busy) return
      setError(''); setPending(entries.find(row => row.nativeId === detail.nativeId) ?? { nativeId: detail.nativeId, sessionId: detail.nativeId.startsWith('agent-bridge-') ? '?' : '', workerId: '', groupId: '', groupTitle: '', groupUpdatedAt: 0, executionLocations: [], machineId: '', workspace: '', title: detail.title || 'DSH 对话', status: '', worker: 'DSH', updatedAt: 0, activityAt: 0 })
    }
    window.addEventListener(DELETE_SESSION_EVENT, request)
    // Renaming needs no confirmation: it only asks the Control Plane for a new title; a failure shows here.
    const retitle = (event: Event) => {
      const nativeId = (event as CustomEvent<{ nativeId: string }>).detail?.nativeId
      if (typeof nativeId === 'string') void catalog.retitle(nativeId).catch(cause => { setPending(undefined); setRetitleError(cause instanceof Error ? cause.message : '重新起名失败') })
    }
    window.addEventListener(RETITLE_SESSION_EVENT, retitle)
    return () => { window.removeEventListener(DELETE_SESSION_EVENT, request); window.removeEventListener(RETITLE_SESSION_EVENT, retitle) }
  }, [entries, busy])
  return <>{retitleError && <div role="alert" className={css.help}>{retitleError}</div>}{pending && <div className={css.sourceOverlay}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-session-title" className={css.sourceDialog}>
      <h2 id="delete-session-title">删除此会话？</h2><p className={css.deleteTitle}>{pending.title}</p><p className={css.help}>{pending.worker}{pending.workspace ? ' · ' + pending.workspace : ''}</p>
      <p>{pending.sessionId ? '将删除 Bridge 中的会话并从客户端列表移除。' : '将删除此 DSH 对话的列表记录。底层日志保留以便恢复。'}工作目录和项目文件会保留。</p>
      {error && <p role="alert">{error}</p>}
      <footer className={css.dialogFooter}><button type="button" disabled={busy} onClick={() => setPending(undefined)}>取消</button><button type="button" className={css.dangerButton} disabled={busy} onClick={() => { setBusy(true); void catalog.remove(pending).then(() => setPending(undefined)).catch(cause => setError(cause instanceof Error ? cause.message : '删除失败')).finally(() => setBusy(false)) }}>{busy ? '正在删除…' : '确认删除'}</button></footer>
    </div></div>}</>
}
