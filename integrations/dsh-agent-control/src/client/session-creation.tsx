import { useEffect, useState, useSyncExternalStore } from 'react'
import css from './workspace.module.css'
import { useDialog } from './dialog.js'

type Source = { id: string; name: string; workerId?: string; machineId: string; workspace: string; available: boolean }
type Options = { workspaceId?: string; cwd?: string; sessionId?: string }
export interface CreationSessions { create(options?: Options): Promise<string>; refresh(): Promise<void> }
export interface CreationWorkspaces { list: { getSnapshot(): { items: { workspaceId: string; path: string }[] } } }
export interface CreationNavigation { connectWorkspace(workspaceId: string): Promise<string> }
type Rpc = (operation: string, args: Record<string, string>) => Promise<unknown>
type Pending = { sources: Source[]; resolve(source: Source): void; reject(error: Error): void }

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
    async function create(this: CreationSessions, options?: Options): Promise<string> {
      if (options?.sessionId) return original.call(this, options)
      const cwd = options?.cwd ?? workspaces.list.getSnapshot().items.find(item => item.workspaceId === options?.workspaceId)?.path
      if (options?.workspaceId && !cwd) throw new Error('目录尚未加载，请刷新后重试')
      if (!cwd) return original.call(this, options)
      const result = await controller.rpc('creation_sources', { cwd }) as { sources: Source[] }
      if (!Array.isArray(result.sources)) throw new Error('Bridge directory sources are unavailable')
      if (result.sources.length === 1 && result.sources[0]?.id === 'dsh') return original.call(this, options)
      if (!result.sources.length) throw new Error('No execution source is available for this directory')
      controller.cancel()
      const source = await new Promise<Source>((resolve, reject) => { controller.pending = { sources: result.sources, resolve, reject }; controller.emit() })
      if (source.id === 'dsh') return original.call(this, options)
      const created = await controller.rpc('create_native', { cwd, sourceId: source.id }) as { nativeSessionId?: string }
      if (!created.nativeSessionId) throw new Error('Bridge returned no native session identity')
      // Preserve the native create contract: the returned session is immediately addressable.
      await sessions.refresh()
      return created.nativeSessionId
    }
    sessions.create = create
    const connect = navigation?.connectWorkspace
    // Native navigation otherwise reuses a blank DSH session without calling create.
    const createInDirectory = (workspaceId: string) => sessions.create({ workspaceId })
    if (navigation) navigation.connectWorkspace = createInDirectory
    return () => {
      controller.cancel()
      if (sessions.create === create) sessions.create = original
      if (navigation && connect && navigation.connectWorkspace === createInDirectory) navigation.connectWorkspace = connect
    }
  }
}

export function SessionSourcePicker({ controller }: { controller: SessionCreationController }) {
  const pending = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [selected, setSelected] = useState('')
  const ref = useDialog(!!pending, controller.cancel)
  useEffect(() => { setSelected(pending?.sources.find(source => source.available)?.id ?? '') }, [pending])
  if (!pending) return null
  const choice = pending.sources.find(source => source.id === selected && source.available)
  return <div className={css.sourceOverlay} onMouseDown={event => { if (event.target === event.currentTarget) controller.cancel() }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="bridge-source-title" aria-describedby="bridge-source-help" className={css.sourceDialog}>
      <header className={css.dialogHeader}><div><span className={css.eyebrow}>新建对话</span><h2 id="bridge-source-title">选择运行此对话的 Agent</h2></div><button type="button" className={css.iconButton} aria-label="关闭来源选择" onClick={controller.cancel}>×</button></header>
      <p id="bridge-source-help" className={css.help}>对话将在所选机器的目录中运行。</p>
      <fieldset className={css.sourceList}><legend className={css.srOnly}>可用 Agent</legend>{pending.sources.map(source => <label key={source.id} className={`${css.sourceCard} ${selected === source.id ? css.sourceSelected : ''} ${!source.available ? css.sourceOffline : ''}`}>
        <input type="radio" name="bridge-source" value={source.id} checked={selected === source.id} disabled={!source.available} onChange={() => setSelected(source.id)} />
        <span className={css.sourceIcon} aria-hidden="true">{source.name.startsWith('Claude') ? 'Cl' : source.id === 'dsh' ? 'DS' : 'Cx'}</span>
        <span className={css.sourceInfo}><span className={css.sourceName}><strong>{source.name}</strong><span className={css.availability}>{source.available ? '可用' : '离线'}</span></span><span className={css.sourceMachine}>{source.id === 'dsh' ? '本机' : source.machineId}</span><code className={css.sourcePath}>{source.workspace}</code></span>
      </label>)}</fieldset>
      {!choice && <p className={css.help} role="status">暂无在线 Agent，请稍后重试。</p>}
      <footer className={css.dialogFooter}><button type="button" onClick={controller.cancel}>取消</button><button type="button" className={css.primary} disabled={!choice} onClick={() => { if (choice) controller.select(choice) }}>创建对话 <span aria-hidden="true">→</span></button></footer>
    </div>
  </div>
}
