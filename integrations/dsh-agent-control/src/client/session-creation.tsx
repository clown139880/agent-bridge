import { useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

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
  return <div role="dialog" aria-modal="true" aria-label="选择新会话来源" style={{pointerEvents:'auto',position:'fixed',inset:0,zIndex:1100,background:'#0006',display:'grid',placeItems:'center'}}>
    <section style={{width:'min(560px,90vw)',padding:24,borderRadius:16,background:'#fff',color:'#17252b',boxShadow:'0 16px 60px #0004'}}>
      <header style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><strong>选择新会话来源</strong><Button onClick={controller.cancel}>取消</Button></header>
      <p>选择执行这个新对话的 worker。</p>
      {pending.sources.map(source => <Button key={source.id} disabled={!source.available} onClick={() => controller.select(source)} style={{display:'block',width:'100%',textAlign:'left',whiteSpace:'normal',height:'auto',padding:14,marginTop:10,border:'1px solid #c8d5d2',borderRadius:10,color:'#17252b',background:'#f4faf8'}}>
        <strong>{source.name}{source.available ? '' : ' · 离线'}</strong>
        <span style={{display:'block',marginTop:6,fontSize:12,overflowWrap:'anywhere'}}>{source.machineId} · {source.workspace}</span>
      </Button>)}
    </section>
  </div>
}
