import type { NativeCatalog, NativeEntry } from './native-catalog.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ModelSelection = { provider: string; model: string; reasoningEffort?: string }
type SelectModel = (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => Promise<{
  ok: boolean
  error?: { code?: string; message?: string }
}>
type DirectoryModel = { id: string; name: string; description?: string; reasoning?: { defaultEffort?: string; efforts: Array<{ id: string; name: string }> } }
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
function array(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : [] }
function text(value: JsonValue | undefined): string { return typeof value === 'string' ? value.trim() : '' }

/** Adopt a DSH catalog model verbatim; its id is already provider-qualified where that matters. */
function directoryModel(value: JsonValue): DirectoryModel | undefined {
  const model = record(value)
  const id = text(model['id'])
  if (!id) return undefined
  const reasoning = record(model['reasoning'])
  const efforts = array(reasoning['efforts']).flatMap(entry => {
    const effort = text(record(entry)['id'])
    return effort ? [{ id: effort, name: text(record(entry)['name']) || effort }] : []
  })
  const defaultEffort = text(reasoning['defaultEffort'])
  const description = text(model['description'])
  return {
    id, name: text(model['name']) || id,
    ...(description ? { description } : {}),
    ...(efforts.length || defaultEffort ? { reasoning: { ...(defaultEffort ? { defaultEffort } : {}), efforts } } : {}),
  }
}

function isGptModel(model: DirectoryModel): boolean {
  return /(?:^|[/#])gpt(?:[-_.]|$)/i.test(model.id) || /^gpt(?:[-_.]|$)/i.test(model.name)
}
function isCodexWorker(entry: NativeEntry): boolean {
  // The worker id is `<codex|claude|pi>@machine`; the execution location's agent
  // and the display name are fallbacks for catalogs that predate that format.
  const location = entry.executionLocations.find(value => value.workerId === entry.workerId)
  return /^codex\b/i.test(entry.workerId) || /codex/i.test(`${entry.worker} ${location?.agent ?? ''}`)
}

/**
 * Codex reaches the relay over the OpenAI Responses wire (`wire_api =
 * "responses"`), which only serves the GPT family, so a Codex session must not
 * be offered anything else. Claude and Pi reach the same relay over wires that
 * carry every model, so they get the whole catalog.
 */
export function modelsForWorker(entry: NativeEntry, models: readonly DirectoryModel[]): DirectoryModel[] {
  return isCodexWorker(entry) ? models.filter(isGptModel) : [...models]
}

/**
 * One DSH model catalog shared by every Bridge session directory. Bridge workers
 * advertise no usable catalog of their own, and DSH already knows every provider
 * it is configured against, so the menu reads that instead of round-tripping the
 * control plane. It is a Host-generation value: fetched once, reused until a
 * Host-side model input invalidates it.
 */
export class NativeModels {
  private cached: DirectoryModel[] | undefined
  private inflight: Promise<DirectoryModel[]> | undefined
  constructor(private readonly loadCatalog: () => Promise<JsonValue>) {}

  invalidate(): void { this.cached = undefined; this.inflight = undefined }

  async load(): Promise<DirectoryModel[]> {
    if (this.cached) return this.cached
    if (this.inflight) return this.inflight
    const operation = this.fetch().then(models => { this.cached = models; return models })
      .finally(() => { if (this.inflight === operation) this.inflight = undefined })
    this.inflight = operation
    return operation
  }

  private async fetch(): Promise<DirectoryModel[]> {
    const groups = array(record(await this.loadCatalog())['groups']).map(record)
    if (!groups.length) throw new Error('DSH 未提供任何模型 provider。')
    // Every provider's models, deduplicated by id: the Bridge worker routes one
    // upstream relay, so which DSH provider surfaced a model carries no meaning.
    const models = new Map<string, DirectoryModel>()
    for (const group of groups) for (const value of array(group['models'])) {
      const model = directoryModel(value)
      if (model && !models.has(model.id)) models.set(model.id, model)
    }
    if (!models.size) throw new Error('DSH 模型目录为空。')
    return [...models.values()]
  }
}

function sameState(left: DirectoryState, right: DirectoryState): boolean {
  if (left === right) return true
  if (left.status !== right.status || left.error !== right.error || left.routable !== right.routable) return false
  return JSON.stringify([left.current, left.groups, left.failures]) === JSON.stringify([right.current, right.groups, right.failures])
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

  constructor(private readonly nativeId: string, private readonly catalog: NativeCatalog, private readonly models: NativeModels, private readonly selectModel: SelectModel) {
    this.syncEntry(catalog.entry(nativeId))
    this.stopCatalog = catalog.subscribe(() => this.syncEntry(catalog.entry(nativeId)))
  }

  private set(state: DirectoryState): void {
    // The session catalog polls on a timer and every load rebuilds the group
    // array, so identity alone cannot tell an unchanged catalog from a changed
    // one. Notifying on a structurally identical snapshot re-renders the
    // composer model seat and reads as a flicker.
    if (this.disposed || sameState(this.state, state)) return
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
    // Keep a loaded menu on screen across reloads; only a first load shows the
    // loading affordance, so a failing reload cannot flash loading → error.
    if (!this.state.groups.length) this.set({ ...this.state, status: 'loading', error: null })
    try {
      let entry = this.catalog.entry(this.nativeId)
      if (!entry) { await this.catalog.refresh(); entry = this.catalog.entry(this.nativeId) }
      if (!entry) throw new Error('Bridge 会话尚未同步，请稍后重试。')
      if (!entry.workerId) throw new Error('Bridge 会话缺少执行 worker。')
      const models = modelsForWorker(entry, await this.models.load())
      if (!models.length) throw new Error('此 Bridge worker 没有可用模型。')
      const has = (model: string | undefined) => !!model && models.some(value => value.id === model)
      const currentModel = has(this.state.current?.model) ? this.state.current!.model
        : has(entry.model?.trim()) ? entry.model!.trim() : models[0]!.id
      const reasoningEffort = models.find(value => value.id === currentModel)?.reasoning?.defaultEffort
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
export function installBridgeModelDirectories(resolver: Resolver, catalog: NativeCatalog, models: NativeModels, selectModel: SelectModel): () => void {
  const original = resolver.directoryFor.bind(resolver)
  const directories = new Map<string, BridgeModelDirectory>()
  resolver.directoryFor = (sessionId: string) => {
    if (!sessionId.startsWith('agent-bridge-')) return original(sessionId)
    let directory = directories.get(sessionId)
    if (!directory) { directory = new BridgeModelDirectory(sessionId, catalog, models, selectModel); directories.set(sessionId, directory) }
    return directory
  }
  return () => {
    resolver.directoryFor = original
    for (const directory of directories.values()) directory.dispose()
    directories.clear()
  }
}
