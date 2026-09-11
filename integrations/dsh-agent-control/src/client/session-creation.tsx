import { useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './workspace.module.css'

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
  if (!pending) return null
  return <div className={css.workspace} role="dialog" aria-modal="true" aria-label="选择新会话来源">
    <header className={css.topbar}><strong>选择新会话来源</strong><Button onClick={controller.cancel}>取消</Button></header>
    <p>在所选机器的目录中启动会话。</p>
    {pending.sources.map(source => <div key={source.id}>
      <Button disabled={!source.available} onClick={() => controller.select(source)}>{source.name}{source.available ? '' : ' · 离线'}</Button>
      <p>{source.machineId} · {source.workspace}</p>
    </div>)}
  </div>
}
