import type { NativeCatalog, NativeEntry } from './native-catalog.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type Rpc = (operation: string, args?: Record<string, string>) => Promise<JsonValue>
type ModelSelection = { provider: string; model: string; reasoningEffort?: string }
type SelectModel = (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => Promise<{
  ok: boolean
  error?: { code?: string; message?: string }
}>
type BridgeModel = {
  id?: string
  model?: string
  displayName?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>
}
type DirectoryModel = { id: string; name: string; reasoning?: { defaultEffort?: string; efforts: Array<{ id: string; name: string }> } }
type DirectoryState = {
  current: ModelSelection | null
  routable: boolean | null
  groups: Array<{ id: string; name: string; models: DirectoryModel[] }>
  failures: Array<{ id: string; name: string; message: string }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
type SnapshotStore<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void }
type Directory = { store: SnapshotStore<DirectoryState>; load(): Promise<DirectoryState>; select(selection: ModelSelection): Promise<void>; dispose(): void }
type Resolver = { directoryFor(sessionId: string): Directory }

export const BRIDGE_PROVIDER = 'agent-bridge'

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function record(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }

function modelId(model: BridgeModel): string { return (model.model ?? model.id ?? '').trim() }
function isGptModel(model: BridgeModel): boolean {
  return /^gpt(?:[-_\.]|$)/i.test(modelId(model)) || /^gpt(?:[-_\.]|$)/i.test((model.displayName ?? '').trim())
}
function isCodexWorker(entry: NativeEntry): boolean {
  const location = entry.executionLocations.find(value => value.workerId === entry.workerId)
  return /codex/i.test(`${entry.worker} ${location?.agent ?? ''}`)
}
function directoryModel(model: BridgeModel): DirectoryModel | undefined {
  const id = modelId(model)
  if (!id) return undefined
  const efforts = (model.supportedReasoningEfforts ?? []).flatMap(value => {
    const effort = value.reasoningEffort?.trim()
    return effort ? [{ id: effort, name: value.description?.trim() || effort }] : []
  })
  return { id, name: model.displayName?.trim() || id, ...(efforts.length || model.defaultReasoningEffort ? {
    reasoning: { ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}), efforts },
  } : {}) }
}

export class BridgeModelDirectory implements Directory {
  private state: DirectoryState = { current: null, routable: true, groups: [], failures: [], status: 'idle', error: null }
  private readonly listeners = new Set<() => void>()
  private inflight: Promise<DirectoryState> | undefined
  private selected = false
  private disposed = false
  private readonly stopCatalog: () => void
  readonly store: SnapshotStore<DirectoryState> = {
    getSnapshot: () => this.state,
    subscribe: listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }

  constructor(private readonly nativeId: string, private readonly catalog: NativeCatalog, private readonly rpc: Rpc, private readonly selectModel: SelectModel) {
    this.syncEntry(catalog.entry(nativeId))
    this.stopCatalog = catalog.subscribe(() => this.syncEntry(catalog.entry(nativeId)))
  }

  private set(state: DirectoryState): void {
    if (this.disposed) return
    this.state = state
    for (const listener of this.listeners) listener()
  }

  private syncEntry(entry: NativeEntry | undefined): void {
    if (this.disposed || this.selected || !entry?.model?.trim()) return
    const current = this.state.current
    if (current?.model === entry.model) return
    this.set({ ...this.state, current: { provider: BRIDGE_PROVIDER, model: entry.model } })
  }

  async load(): Promise<DirectoryState> {
    if (this.inflight) return this.inflight
    const operation = this.loadFresh().finally(() => { if (this.inflight === operation) this.inflight = undefined })
    this.inflight = operation
    return operation
  }

  private async loadFresh(): Promise<DirectoryState> {
    this.set({ ...this.state, status: 'loading', error: null })
    try {
      let entry = this.catalog.entry(this.nativeId)
      if (!entry) { await this.catalog.refresh(); entry = this.catalog.entry(this.nativeId) }
      if (!entry) throw new Error('Bridge 会话尚未同步，请稍后重试。')
      if (!entry.workerId) throw new Error('Bridge 会话缺少执行 worker。')
      const response = record(await this.rpc('models', { workerId: entry.workerId }))
      if (!Array.isArray(response['models'])) throw new Error('Bridge worker 返回了无效的模型列表。')
      const raw = response['models'].map(value => record(value) as BridgeModel)
      // GPT models are Codex-only. Other models are deliberately left available
      // to every Agent; the worker catalog remains the source of truth for them.
      const compatible = isCodexWorker(entry) ? raw : raw.filter(value => !isGptModel(value))
      const models = compatible.flatMap(value => { const model = directoryModel(value); return model ? [model] : [] })
      if (!models.length) throw new Error('此 Bridge worker 没有可用模型。')
      const fallback = compatible.find(value => value.isDefault && modelId(value)) ?? compatible.find(value => modelId(value))
      const currentModel = (compatible.some(value => modelId(value) === this.state.current?.model) ? this.state.current?.model
        : compatible.some(value => modelId(value) === entry.model?.trim()) ? entry.model?.trim() : (fallback ? modelId(fallback) : '')
      ) ?? ''
      const selectedModel = compatible.find(value => modelId(value) === currentModel)
      const reasoningEffort = selectedModel?.defaultReasoningEffort?.trim()
      const current = { provider: BRIDGE_PROVIDER, model: currentModel, ...(reasoningEffort ? { reasoningEffort } : {}) }
      this.set({ current, routable: true, groups: [{ id: BRIDGE_PROVIDER, name: `Agent Bridge · ${entry.worker}`, models }], failures: [], status: 'ready', error: null })
      return this.state
    } catch (error) {
      this.set({ ...this.state, status: 'error', error: errorText(error) })
      throw error
    }
  }

  async select(selection: ModelSelection): Promise<void> {
    if (selection.provider !== BRIDGE_PROVIDER) throw new Error('Bridge 会话只能选择当前 worker 提供的模型。')
    if (!this.state.groups[0]?.models.some(model => model.id === selection.model)) throw new Error('所选模型不在当前 Bridge worker 的模型列表中。')
    this.set({ ...this.state, status: 'selecting', error: null })
    try {
      const result = await this.selectModel({ sessionId: this.nativeId, provider: BRIDGE_PROVIDER, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) })
      if (!result.ok) throw new Error(`${result.error?.code ?? 'select_failed'}: ${result.error?.message ?? '模型选择失败'}`)
      this.selected = true
      this.set({ ...this.state, current: selection, status: 'ready', error: null })
    } catch (error) {
      this.set({ ...this.state, status: 'error', error: errorText(error) })
      throw error
    }
  }

  dispose(): void { this.disposed = true; this.stopCatalog(); this.listeners.clear() }
}

/** Route only imported Bridge sessions to worker-scoped models; native DSH sessions keep their original directory. */
export function installBridgeModelDirectories(resolver: Resolver, catalog: NativeCatalog, rpc: Rpc, selectModel: SelectModel): () => void {
  const original = resolver.directoryFor.bind(resolver)
  const directories = new Map<string, BridgeModelDirectory>()
  resolver.directoryFor = (sessionId: string) => {
    if (!sessionId.startsWith('agent-bridge-')) return original(sessionId)
    let directory = directories.get(sessionId)
    if (!directory) { directory = new BridgeModelDirectory(sessionId, catalog, rpc, selectModel); directories.set(sessionId, directory) }
    return directory
  }
  return () => {
    resolver.directoryFor = original
    for (const directory of directories.values()) directory.dispose()
    directories.clear()
  }
}
