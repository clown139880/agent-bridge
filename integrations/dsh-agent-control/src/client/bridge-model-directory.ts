import type { NativeCatalog, NativeEntry } from './native-catalog.js'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ModelSelection = { provider: string; model: string; reasoningEffort?: string }
type SelectModel = (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => Promise<{
  ok: boolean
  error?: { code?: string; message?: string }
}>
type DirectoryModel = {
  id: string
  name: string
  description?: string
  /** Relay-declared wire protocols; the worker's transport must appear here. */
  endpoints?: string[]
  reasoning?: { defaultEffort?: string; efforts: Array<{ id: string; name: string }> }
}
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
/** Sends no model: the worker keeps whatever the remote session already runs. */
export const REMOTE_MODEL = 'remote'

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function record(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function array(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : [] }
function text(value: JsonValue | undefined): string { return typeof value === 'string' ? value.trim() : '' }

function directoryModel(value: JsonValue): DirectoryModel | undefined {
  const model = record(value)
  const id = text(model['id'])
  if (!id) return undefined
  const endpoints = array(model['endpoints']).map(text).filter(Boolean)
  const description = text(model['description'])
  return {
    id, name: text(model['name']) || id,
    ...(description ? { description } : {}),
    ...(endpoints.length ? { endpoints } : {}),
  }
}

/** The wire each coding agent speaks to the relay; anything else it cannot route. */
const AGENT_ENDPOINT: Record<string, string> = {
  codex: 'openai-response',
  claude: 'anthropic',
  pi: 'openai',
}

function agentOf(entry: NativeEntry): string {
  // The worker id is `<codex|claude|pi>@machine`; the execution location's agent
  // and the display name are fallbacks for catalogs that predate that format.
  const prefix = entry.workerId.split('@')[0]?.trim().toLowerCase() ?? ''
  if (AGENT_ENDPOINT[prefix]) return prefix
  const location = entry.executionLocations.find(value => value.workerId === entry.workerId)
  const haystack = `${entry.worker} ${location?.agent ?? ''}`.toLowerCase()
  return Object.keys(AGENT_ENDPOINT).find(agent => haystack.includes(agent)) ?? ''
}

/**
 * Keep the models this worker's transport can actually reach. The relay maps one
 * model onto several wires, so the filter is the endpoint type the relay
 * declares — not the model's name. A row that declares no endpoints at all is
 * kept: some relays disclose nothing, and guessing would hide working models.
 */
export function modelsForWorker(entry: NativeEntry, models: readonly DirectoryModel[]): DirectoryModel[] {
  const endpoint = AGENT_ENDPOINT[agentOf(entry)]
  if (!endpoint) return [...models]
  return models.filter(model => !model.endpoints?.length || model.endpoints.includes(endpoint))
}

/**
 * Model families, in menu order. The relay's rows carry no vendor field
 * (`owned_by` is mostly "custom"), so the family is read off the id.
 */
const FAMILIES: ReadonlyArray<{ id: string; name: string; pattern: RegExp }> = [
  { id: 'claude', name: 'Claude', pattern: /^claude/i },
  { id: 'openai', name: 'OpenAI', pattern: /^(gpt|codex|o\d)/i },
  { id: 'gemini', name: 'Gemini', pattern: /^gemini/i },
  { id: 'deepseek', name: 'DeepSeek', pattern: /^deepseek/i },
  { id: 'qwen', name: 'Qwen', pattern: /^qwen/i },
  { id: 'glm', name: 'GLM', pattern: /^glm/i },
  { id: 'kimi', name: 'Kimi', pattern: /^kimi/i },
  { id: 'minimax', name: 'MiniMax', pattern: /^minimax/i },
  { id: 'gemma', name: 'Gemma', pattern: /^gemma/i },
  { id: 'nemotron', name: 'Nemotron', pattern: /^nemotron/i },
]
const OTHER_FAMILY = { id: 'other', name: '其他' }
const AUTO_GROUP = `${BRIDGE_PROVIDER}:auto`

/** DSH keys a selection by its group id, so each family group gets its own Bridge-scoped id. */
export function groupIdOf(model: string): string {
  if (model === REMOTE_MODEL) return AUTO_GROUP
  return `${BRIDGE_PROVIDER}:${FAMILIES.find(family => family.pattern.test(model))?.id ?? OTHER_FAMILY.id}`
}

export function isBridgeGroup(provider: string): boolean {
  return provider === BRIDGE_PROVIDER || provider.startsWith(`${BRIDGE_PROVIDER}:`)
}

/** The auto choice first, then one group per family with newer-looking ids on top. */
export function groupModels(models: readonly DirectoryModel[]): DirectoryState['groups'] {
  const byFamily = new Map<string, DirectoryModel[]>()
  for (const model of models) {
    const id = groupIdOf(model.id)
    const rows = byFamily.get(id)
    if (rows) rows.push(model); else byFamily.set(id, [model])
  }
  const order = [...FAMILIES, OTHER_FAMILY]
  return [
    { id: AUTO_GROUP, name: '自动', models: [{ id: REMOTE_MODEL, name: 'Remote auto', description: '不指定模型，沿用远端会话 / worker 的默认模型' }] },
    ...order.flatMap(family => {
      const rows = byFamily.get(`${BRIDGE_PROVIDER}:${family.id}`)
      return rows ? [{ id: `${BRIDGE_PROVIDER}:${family.id}`, name: family.name,
        models: [...rows].sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true })) }] : []
    }),
  ]
}

const RECENT_KEY = 'agent-control:recent-bridge-model'

/**
 * The model a new Bridge session starts on: the one last picked in this client
 * for the same agent, else the one the most recently used session of that
 * agent ran. Both are hints — the caller still checks the model is served.
 */
function recentModels(catalog: NativeCatalog, entry: NativeEntry): string[] {
  const agent = agentOf(entry)
  const picked: string[] = []
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? '{}') as Record<string, unknown>
    if (typeof stored[agent] === 'string') picked.push(stored[agent])
  } catch { /* storage unavailable or corrupt: fall back to the catalog */ }
  const used = catalog.snapshot()
    .filter(row => row.nativeId !== entry.nativeId && row.model?.trim() && agentOf(row) === agent)
    .sort((left, right) => (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt))
    .map(row => row.model!.trim())
  return [...picked, ...used]
}

function rememberModel(entry: NativeEntry | undefined, model: string): void {
  if (!entry) return
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? '{}') as Record<string, unknown>
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify({ ...stored, [agentOf(entry)]: model }))
  } catch { /* remembering is a convenience */ }
}

/**
 * The relay catalog shared by every Bridge session directory. DSH's own provider
 * settings only list the models someone registered by hand, and the Bridge
 * workers each describe a partial view, so the menu asks the Host for what the
 * configured relay actually serves. The Host holds it for a while; this keeps
 * one in-flight request per client.
 */
export class NativeModels {
  private cached: DirectoryModel[] | undefined
  private inflight: Promise<DirectoryModel[]> | undefined
  constructor(private readonly rpc: (operation: string, args?: Record<string, string>) => Promise<JsonValue>) {}

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
    const rows = array(record(await this.rpc('provider_models'))['models'])
    const models = new Map<string, DirectoryModel>()
    for (const value of rows) {
      const model = directoryModel(value)
      if (model && !models.has(model.id)) models.set(model.id, model)
    }
    if (!models.size) throw new Error('已配置的 provider 没有返回可用模型。')
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
    this.set({ ...this.state, current: { provider: groupIdOf(entry.model), model: entry.model } })
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
      const has = (model: string | undefined) => !!model && (model === REMOTE_MODEL || models.some(value => value.id === model))
      // What the menu shows must be what the next turn sends. A Bridge agent
      // starts on `remote` (no model sent), so a session with a model of its own
      // just shows it, while a new one either adopts a recent model for real or
      // honestly shows Remote auto — never an arbitrary first row.
      const sessionModel = entry.model?.trim()
      const currentModel = this.selected && has(this.state.current?.model) ? this.state.current!.model
        : has(sessionModel) ? sessionModel! : REMOTE_MODEL
      const recent = this.selected || has(sessionModel) ? undefined
        : recentModels(this.catalog, entry).find(model => model !== REMOTE_MODEL && has(model))
      const reasoningEffort = models.find(value => value.id === currentModel)?.reasoning?.defaultEffort
      const current = { provider: groupIdOf(currentModel), model: currentModel, ...(reasoningEffort ? { reasoningEffort } : {}) }
      this.set({ current, routable: true, groups: groupModels(models), failures: [], status: 'ready', error: null })
      // Adopt the recent model through the Host, exactly as a click would, so the
      // shown model is the sent one; if that fails the menu stays on Remote auto.
      if (recent) await this.select({ provider: groupIdOf(recent), model: recent }, false)
        .catch(() => this.set({ ...this.state, current, status: 'ready', error: null }))
      return this.state
    } catch (error) {
      this.set({ ...this.state, status: 'error', error: errorText(error) })
      throw error
    }
  }

  async select(selection: ModelSelection, remember = true): Promise<void> {
    if (!isBridgeGroup(selection.provider)) throw new Error('Bridge 会话只能选择当前 worker 提供的模型。')
    if (!this.state.groups.some(group => group.models.some(model => model.id === selection.model))) throw new Error('所选模型不在当前 Bridge worker 的模型列表中。')
    this.set({ ...this.state, status: 'selecting', error: null })
    try {
      // The Host knows one Bridge provider; the family group id is menu-only.
      const result = await this.selectModel({ sessionId: this.nativeId, provider: BRIDGE_PROVIDER, model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) })
      if (!result.ok) throw new Error(`${result.error?.code ?? 'select_failed'}: ${result.error?.message ?? '模型选择失败'}`)
      this.selected = true
      if (remember) rememberModel(this.catalog.entry(this.nativeId), selection.model)
      this.set({ ...this.state, current: { ...selection, provider: groupIdOf(selection.model) }, status: 'ready', error: null })
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
