import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import css from './workspace.module.css'
import { useDialog } from './dialog.js'
import { AGENT_LABELS, AgentIcon, agentKind, machineHue, platformLabel } from './agent-identity.js'

type Source = { id: string; name: string; workerId?: string; agentType?: string; machineId: string; machineName?: string; platform?: string; local?: boolean; workspace: string; available: boolean }
type Options = { workspaceId?: string; cwd?: string; sessionId?: string }
export interface CreationSessions { create(options?: Options): Promise<string>; refresh(): Promise<void> }
export interface CreationWorkspaces { list: { getSnapshot(): { items: { workspaceId: string; path: string }[] } } }
export interface CreationNavigation { connectWorkspace(workspaceId: string): Promise<string>; startSession(workspaceId?: string): void }
type Rpc = (operation: string, args: Record<string, string>) => Promise<unknown>
type Pending = { cwd: string; sources: Source[]; resolve(source: Source): void; reject(error: Error): void }

/** Narrow compatibility seam: the original directory action still calls Sessions.create. */
export class SessionCreationController {
  private pending: Pending | undefined
  private readonly listeners = new Set<() => void>()
  constructor(private readonly rpc: Rpc) {}
  snapshot = () => this.pending
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { for (const listener of this.listeners) listener() }
  select = (source: Source) => { const pending = this.pending; this.pending = undefined; this.emit(); pending?.resolve(source) }
  cancel = () => { const pending = this.pending; this.pending = undefined; this.emit(); pending?.reject(new Error('Session creation cancelled')) }
  install(sessions: CreationSessions, workspaces: CreationWorkspaces, navigation?: CreationNavigation): () => void {
    const original = sessions.create
    const controller = this
    let restoringWorkspace = false
    async function create(this: CreationSessions, options?: Options): Promise<string> {
      if (options?.sessionId) return original.call(this, options)
      if (restoringWorkspace) return original.call(this, options)
      const cwd = options?.cwd ?? workspaces.list.getSnapshot().items.find(item => item.workspaceId === options?.workspaceId)?.path
      if (options?.workspaceId && !cwd) throw new Error('目录尚未加载，请刷新后重试')
      if (!cwd) return original.call(this, options)
      const result = await controller.rpc('creation_sources', { cwd }) as { sources: Source[] }
      if (!Array.isArray(result.sources)) throw new Error('Bridge directory sources are unavailable')
      if (result.sources.length === 1 && result.sources[0]?.id === 'dsh') return original.call(this, options)
      if (!result.sources.length) throw new Error('No execution source is available for this directory')
      controller.cancel()
      const source = await new Promise<Source>((resolve, reject) => { controller.pending = { cwd, sources: result.sources, resolve, reject }; controller.emit() })
      if (source.id === 'dsh') return original.call(this, options)
      const created = await controller.rpc('create_native', { cwd, sourceId: source.id }) as { nativeSessionId?: string }
      if (!created.nativeSessionId) throw new Error('Bridge returned no native session identity')
      // Preserve the native create contract: the returned session is immediately addressable.
      await sessions.refresh()
      return created.nativeSessionId
    }
    sessions.create = create
    const connect = navigation?.connectWorkspace
    const start = navigation?.startSession
    let explicitStart = false
    // Startup restoration and ordinary directory navigation share the same DSH
    // method as explicit creation. Preserve the native path for the former, and
    // only force source selection while startSession is handling a user action.
    const connectDirectory = (workspaceId: string) => {
      if (explicitStart) return sessions.create({ workspaceId })
      restoringWorkspace = true
      try { return connect!.call(navigation, workspaceId) }
      finally { restoringWorkspace = false }
    }
    const startSession = (workspaceId?: string) => {
      explicitStart = true
      try { start!.call(navigation, workspaceId) }
      finally { explicitStart = false }
    }
    if (navigation && connect && start) { navigation.connectWorkspace = connectDirectory; navigation.startSession = startSession }
    return () => {
      controller.cancel()
      if (sessions.create === create) sessions.create = original
      if (navigation && connect && navigation.connectWorkspace === connectDirectory) navigation.connectWorkspace = connect
      if (navigation && start && navigation.startSession === startSession) navigation.startSession = start
    }
  }
}

const LAST_SOURCE = 'agent-control:last-source:'
const remembered = (cwd: string) => { try { return localStorage.getItem(LAST_SOURCE + cwd) ?? '' } catch { return '' } }
const remember = (cwd: string, id: string) => { try { localStorage.setItem(LAST_SOURCE + cwd, id) } catch { /* storage may be unavailable */ } }

type MachineGroup = { key: string; machineId: string; label: string; platform: string; local: boolean; workspace: string; sources: Source[] }
/** One execution location per group: the machine and its directory are stated once, agents become a choice within it. */
export function groupSources(sources: readonly Source[]): MachineGroup[] {
  const groups = new Map<string, MachineGroup>()
  for (const source of sources) {
    const local = source.id === 'dsh' || !!source.local
    const key = (local ? 'local' : source.machineId) + '\0' + source.workspace
    let group = groups.get(key)
    if (!group) groups.set(key, group = { key, machineId: source.machineId, label: '', platform: source.platform ?? '', local, workspace: source.workspace, sources: [] })
    group.sources.push(source)
    // A local Bridge worker names the machine better than the bare DSH hostname.
    if (!group.label || source.id !== 'dsh') { group.label = source.machineName || source.name.split(/\s@\s/)[1] || source.machineId; if (source.id !== 'dsh') group.machineId = source.machineId }
    if (!group.platform && source.platform) group.platform = source.platform
  }
  return [...groups.values()].sort((left, right) => Number(right.local) - Number(left.local))
}

export function SessionSourcePicker({ controller }: { controller: SessionCreationController }) {
  const pending = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [selected, setSelected] = useState('')
  const ref = useDialog(!!pending, controller.cancel)
  useEffect(() => {
    const last = pending && remembered(pending.cwd)
    setSelected(pending?.sources.find(source => source.id === last && source.available)?.id ?? pending?.sources.find(source => source.available)?.id ?? '')
  }, [pending])
  if (!pending) return null
  const choice = pending.sources.find(source => source.id === selected && source.available)
  const create = () => { if (choice) { remember(pending.cwd, choice.id); controller.select(choice) } }
  return <div className={css.sourceOverlay} onMouseDown={event => { if (event.target === event.currentTarget) controller.cancel() }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="bridge-source-title" aria-describedby="bridge-source-help" className={css.sourceDialog}>
      <header className={css.dialogHeader}><div><span className={css.eyebrow}>新建对话</span><h2 id="bridge-source-title">选择机器与 Agent</h2></div><button type="button" className={css.iconButton} aria-label="关闭来源选择" onClick={controller.cancel}>×</button></header>
      <p id="bridge-source-help" className={css.help}>执行位置独立于项目分组；对话将在所选机器的目录中运行。</p>
      <div className={css.sourceList}>{groupSources(pending.sources).map(group => {
        const online = group.sources.some(source => source.available)
        return <fieldset key={group.key} className={`${css.machineGroup} ${!online ? css.sourceOffline : ''}`} style={{ '--machine-hue': machineHue(group.machineId) } as CSSProperties}>
          <legend className={css.srOnly}>{group.label}</legend>
          <div className={css.machineHeader} aria-hidden="true">
            <span className={css.machineDot} />
            <strong>{group.label}</strong>
            {group.local && <span className={css.localTag}>本机</span>}
            {platformLabel(group.platform) && <span className={css.platformTag}>{platformLabel(group.platform)}</span>}
            <span className={css.availability}>{online ? '在线' : '离线'}</span>
          </div>
          <code className={css.sourcePath} title={group.workspace}>{group.workspace}</code>
          <div className={css.agentChoices}>{group.sources.map(source => {
            const agent = agentKind({ agentType: source.agentType, workerId: source.workerId ?? source.id, name: source.name })
            const label = agent ? AGENT_LABELS[agent] : source.name.split(/\s@\s/)[0]
            return <label key={source.id} title={source.name} onDoubleClick={() => { if (source.available) { remember(pending.cwd, source.id); controller.select(source) } }} className={`${css.agentChoice} ${selected === source.id ? css.sourceSelected : ''} ${!source.available ? css.sourceOffline : ''}`}>
              <input type="radio" name="bridge-source" value={source.id} aria-label={`${label} @ ${group.label}`} checked={selected === source.id} disabled={!source.available} onChange={() => setSelected(source.id)} />
              <AgentIcon agent={agent} size={22} />
              <span>{label}</span>
            </label>
          })}</div>
        </fieldset>
      })}</div>
      {!choice && <p className={css.help} role="status">暂无在线 Agent，请稍后重试。</p>}
      <footer className={css.dialogFooter}><button type="button" onClick={controller.cancel}>取消</button><button type="button" className={css.primary} disabled={!choice} onClick={create}>创建对话 <span aria-hidden="true">→</span></button></footer>
    </div>
  </div>
}
