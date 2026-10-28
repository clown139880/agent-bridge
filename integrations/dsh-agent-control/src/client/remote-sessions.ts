import { isVirtualSession } from '../remote-sessions/id.js'
import type { JsonObject, JsonValue } from '../types.js'
import type { NativeEntry } from './native-catalog.js'

export const READ_ONLY = 'Bridge 远端会话不支持此操作，请在 Control Center 中进行。'
const ATTACHMENTS = 'Bridge 远端会话暂不支持在 DSH 中发送图片或文件，请在 Control Center 中发送。'
type Rpc = (operation: string, args?: JsonObject) => Promise<JsonValue>
type Method = (...args: unknown[]) => unknown
type Namespace = Record<string, unknown>
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
export function virtualTarget(value: unknown): string | undefined {
  if (isVirtualSession(value)) return value
  if (value && typeof value === 'object') for (const nested of Object.values(value)) { const id = virtualTarget(nested); if (id) return id }
  return undefined
}
export function readonlyResult(message = READ_ONLY) { return { ok: false as const, error: { code: 'gateway/bad-request', message, details: {} } } }
const RUNNING = new Set(['creating', 'active', 'waiting_for_approval', 'waiting_for_input'])
export const virtualRunning = (entry: Pick<NativeEntry, 'status'>) => RUNNING.has(String(entry.status ?? ''))
/** Preserve the generated getter's caller Context, not a bound root Remote. */
export function wrapNamespace(namespace: Namespace, dispatch: (name: string, args: unknown[], original: Method) => unknown): () => void {
  const restorers: Array<() => void> = []
  for (const name of Object.keys(namespace)) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, name)
    if (!descriptor?.configurable || typeof namespace[name] !== 'function') continue
    const get = function(this: Namespace): Method {
      const method = (descriptor.get ? descriptor.get.call(this) : descriptor.value) as Method
      return (...args) => dispatch(name, args, (...values) => method.apply(this, values))
    }
    Object.defineProperty(namespace, name, { configurable: true, enumerable: descriptor.enumerable ?? false, get })
    restorers.push(() => { if (Object.getOwnPropertyDescriptor(namespace, name)?.get === get) Object.defineProperty(namespace, name, descriptor) })
  }
  return () => { for (const restore of restorers.reverse()) restore() }
}
export function virtualSummary(entry: NativeEntry): JsonObject {
  return { sessionId: entry.nativeId, agentAvailable: false, running: virtualRunning(entry), blank: false, cwd: entry.workspace, updatedAt: entry.activityAt,
    projections: { kind: 'sequenced', asOfSeq: -1, values: { title: entry.title, modelSelection: { lastUsed: { provider: 'agent-bridge', model: entry.model || 'remote' }, next: { provider: 'agent-bridge', model: entry.model || 'remote' } } } } }
}
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() }
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
  const timer = setTimeout(done, 1000)
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
})
export class VirtualSessionTransport {
  private readonly epochs = new Map<string, string>()
  private readonly active = new Set<AbortController>()
  constructor(private readonly rpc: Rpc) {}
  dispose() { for (const controller of this.active) controller.abort(); this.active.clear() }
  async *follow(id: string, callerSignal?: AbortSignal): AsyncIterable<unknown> {
    const controller = new AbortController(); this.active.add(controller)
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
    try {
      signal.throwIfAborted()
      const opened = obj(await this.rpc('virtual_open', { id }))
      signal.throwIfAborted()
      const epoch = String(opened['epoch']); this.epochs.set(id, epoch)
      const snapshot = obj(opened['snapshot'])
      let cursor = Number(snapshot['cursor'])
      yield snapshot
      while (!signal.aborted) {
        await pause(signal)
        const page = obj(await this.rpc('virtual_poll', { id, epoch, after: cursor }))
        signal.throwIfAborted()
        for (const row of page['records'] as Array<{ event: { seq: number } }>) { cursor = row.event.seq; yield row }
      }
    } finally { controller.abort(); this.active.delete(controller) }
  }
  /**
   * The native composer already shows the prompt; the Host tags Bridge's echo of it with
   * this requestId (`source.rpcId`) so the composer retires its local copy.
   */
  async prompt(id: string, request: Record<string, unknown>, choice?: { model: string; reasoningEffort?: string }) {
    const parts = Array.isArray(request['content']) ? request['content'].map(obj) : []
    if (parts.some(part => part['type'] !== 'text')) return readonlyResult(ATTACHMENTS)
    const text = parts.map(part => String(part['text'] ?? '')).join('')
    if (!text.trim()) return readonlyResult('消息为空')
    try {
      await this.rpc('virtual_prompt', { id, requestId: String(request['requestId']), text,
        ...(choice?.model ? { model: choice.model } : {}), ...(choice?.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) })
      return { ok: true as const, value: { accepted: true as const } }
    } catch (error) { return readonlyResult(error instanceof Error ? error.message : String(error)) }
  }
  async cancel(id: string) {
    try { await this.rpc('virtual_cancel', { id }); return { ok: true as const, value: { accepted: true as const } } }
    catch (error) { return readonlyResult(error instanceof Error ? error.message : String(error)) }
  }
  async page(id: string, request: Record<string, unknown>) {
    const epoch = this.epochs.get(id)
    if (!epoch) throw new Error('请先打开 Bridge 会话')
    return { ok: true, value: await this.rpc('virtual_page', { id, epoch, throughSeq: Number(request['throughSeq']),
      ...(request['beforeSeq'] === undefined ? {} : { beforeSeq: Number(request['beforeSeq']) }),
      ...(request['maxMessages'] === undefined ? {} : { maxMessages: Number(request['maxMessages']) }) }) }
  }
}
export interface VirtualSessionsFace {
  handleSessionAdded(summary: unknown): void; handleSessionRemoved(id: string): void;
  handleSessionStatus(id: string, running: boolean): void; refresh(): Promise<void>
}
export function installVirtualSessions(remote: Namespace, sessions: VirtualSessionsFace, rpc: Rpc,
  catalog: { snapshot(): NativeEntry[]; subscribe(listener: () => void): () => void }): () => void {
  const transport = new VirtualSessionTransport(rpc)
  let previous = new Set<string>()
  let imported = new Set<string>()
  const originalAdded = sessions.handleSessionAdded
  const originalStatus = sessions.handleSessionStatus
  const added = (summary: unknown) => { if (!imported.has(String(obj(summary)['sessionId']))) originalAdded.call(sessions, summary) }
  const status = (id: string, running: boolean) => { if (!imported.has(id)) originalStatus.call(sessions, id, running) }
  sessions.handleSessionAdded = added
  sessions.handleSessionStatus = status
  // Each handleSession* call makes DSH rebuild its whole session list: publish only what changed.
  let published = new Map<string, string>()
  let runningPublished = new Map<string, boolean>()
  const choices = new Map<string, { model: string; reasoningEffort?: string }>()
  const sync = () => {
    const entries = catalog.snapshot(), next = new Map<string, string>(), running = new Map<string, boolean>()
    const hidden = new Set(entries.map(row => (row as NativeEntry & { importedId?: string }).importedId).filter((id): id is string => !!id))
    for (const id of hidden) if (!imported.has(id)) sessions.handleSessionRemoved(id)
    imported = hidden
    for (const id of previous) if (!entries.some(row => row.nativeId === id)) sessions.handleSessionRemoved(id)
    for (const entry of entries) {
      const summary = virtualSummary(entry), key = JSON.stringify(summary)
      next.set(entry.nativeId, key); running.set(entry.nativeId, virtualRunning(entry))
      if (published.get(entry.nativeId) !== key) sessions.handleSessionAdded(summary)
      // The stop button follows the session's running flag.
      if (runningPublished.get(entry.nativeId) !== running.get(entry.nativeId)) sessions.handleSessionStatus(entry.nativeId, running.get(entry.nativeId)!)
    }
    published = next; runningPublished = running; previous = new Set(next.keys())
  }
  const restores: Array<() => void> = []
  restores.push(wrapNamespace(obj(remote['session']), (name, args, original) => {
    if (name === 'list') return Promise.resolve(original(...args)).then(result => {
      const response = obj(result), value = obj(response['value'])
      if (!response['ok']) return result
      const entries = catalog.snapshot(), hidden = new Set(entries.map(entry => (entry as NativeEntry & { importedId?: string }).importedId))
      return { ...response, value: { ...value, items: [...(value['items'] as Array<{ sessionId: string }>).filter(row => !hidden.has(row.sessionId) && !isVirtualSession(row.sessionId)), ...entries.map(virtualSummary)] } }
    })
    const id = virtualTarget(args[0])
    if (!id) return original(...args)
    if (name === 'follow') return transport.follow(id, args[1] as AbortSignal | undefined)
    if (name === 'page') return transport.page(id, obj(args[0]))
    if (name === 'prompt') return transport.prompt(id, obj(args[0]), choices.get(id))
    if (name === 'cancel') return transport.cancel(id)
    if (name === 'selectModel') {
      // Remembered for the next prompt: a Bridge turn takes its model when it starts.
      const request = obj(args[0])
      choices.set(id, { model: String(request['model'] ?? ''), ...(typeof request['reasoningEffort'] === 'string' ? { reasoningEffort: request['reasoningEffort'] } : {}) })
      return Promise.resolve({ ok: true, value: {} })
    }
    if (name === 'projections') {
      const entry = catalog.snapshot().find(row => row.nativeId === id)
      const block = obj(entry ? virtualSummary(entry)['projections'] : {})
      return Promise.resolve({ ok: true, value: { ...block, kind: 'sequenced' } })
    }
    return Promise.resolve(readonlyResult())
  }))
  // Commands, question continuations, and ancillary per-session APIs must never leak to Host.
  for (const name of ['commands', 'userQuestions', 'subagents']) if (remote[name] && typeof remote[name] === 'object') {
    restores.push(wrapNamespace(obj(remote[name]), (_method, args, original) => virtualTarget(args) ? Promise.resolve(readonlyResult()) : original(...args)))
  }
  const unsubscribe = catalog.subscribe(sync); sync()
  void sessions.refresh().catch(() => {})
  return () => {
    unsubscribe(); transport.dispose(); for (const restore of restores.reverse()) restore()
    if (sessions.handleSessionAdded === added) sessions.handleSessionAdded = originalAdded
    if (sessions.handleSessionStatus === status) sessions.handleSessionStatus = originalStatus
  }
}
