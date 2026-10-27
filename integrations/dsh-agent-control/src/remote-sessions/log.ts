import { createHash, randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { BridgeClient } from '../bridge-client.js'
import type { JsonObject, JsonValue } from '../types.js'
import type { NativeEvent } from '../agent-bridge-provider/dsh-compat.js'
import { readHistory } from '../agent-bridge-provider/import-target.js'
import { projectNativeEvents, str } from '../agent-bridge-provider/mapping.js'
import { VIRTUAL_PREFIX } from './id.js'

export function virtualSessionId(origin: string, remoteId: string): string {
  return VIRTUAL_PREFIX + createHash('sha256').update(new URL(origin).origin + '\0' + remoteId).digest('hex')
}
export function projectRows(rows: readonly JsonObject[], events: readonly NativeEvent[], model = 'remote'): NativeEvent[] {
  return projectNativeEvents(rows, events, model, 'tool-role', undefined, undefined, true)
}
export function historyPage(events: readonly NativeEvent[], through: number, before = through + 1, maxMessages = 80): JsonObject {
  if (!Number.isSafeInteger(through) || through < -1 || through >= events.length || !Number.isSafeInteger(before) || before < 0 || before > through + 1
    || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 1000) throw new Error('Invalid virtual history page cursor')
  const end = before
  let start = end, messages = 0
  while (start > 0) {
    const event = events[--start]!
    if (event.surfaceOp === 'append' && ['user/message', 'assistant/message'].includes(event.type)) messages++
    // Include the whole turn so the native chat reducer never loses a tool/step parent.
    if (messages >= maxMessages && event.type === 'turn/start') break
  }
  return { records: events.slice(start, end).map(event => ({ type: 'event', event: event as unknown as JsonValue })), hasMore: start > 0 }
}
export function projection(title: string, model: string, cursor: number): JsonObject {
  const selection = { provider: 'agent-bridge', model: model || 'remote' }
  return { asOfSeq: cursor, values: { title, modelSelection: { lastUsed: selection, next: selection }, sessionListMetadata: { blank: false, lastPromptAt: null } } }
}
interface Log {
  remoteId: string; epoch: string; events: NativeEvent[]; rows: Map<string, string>; cursor?: string | undefined;
  summary: JsonObject; checkedAt: number; touchedAt: number; invalid: boolean; pending?: Promise<void> | undefined
}
/** No Session, Agent, persistence, or filesystem service is used by this reader. */
export class RemoteSessionLogs {
  private readonly logs = new Map<string, Log>()
  constructor(private readonly bridge: Pick<BridgeClient, 'call'>, private readonly origin: string) {}
  private resolve(id: string, entries: JsonObject[]): JsonObject {
    const entry = entries.find(row => virtualSessionId(this.origin, str(row['sessionId'])) === id && str(row['sessionId']))
    if (!entry) throw new Error('Bridge 虚拟会话不存在，请刷新侧栏')
    return entry
  }
  async open(id: string, entries: JsonObject[], signal?: AbortSignal): Promise<JsonObject> {
    const summary = this.resolve(id, entries)
    for (const [key, log] of this.logs) if (Date.now() - log.touchedAt > 600_000 && !log.pending) this.logs.delete(key)
    let log = this.logs.get(id)
    if (!log || log.invalid) {
      log = { remoteId: str(summary['sessionId']), epoch: randomUUID(), events: [], rows: new Map(), summary, checkedAt: 0, touchedAt: Date.now(), invalid: false }
      this.logs.set(id, log)
    }
    log.summary = summary
    await this.refresh(log, signal)
    const cursor = log.events.length - 1
    return { epoch: log.epoch, snapshot: { type: 'snapshot', header: { version: Number(SESSION_FORMAT_VERSION), id, createdAt: Number(summary['createdAt']) || 0, isSeeded: false, cwd: str(summary['workspace']) }, cursor,
      ...historyPage(log.events, cursor), projections: projection(str(summary['title']), str(summary['model']), cursor), assistantStream: { revision: 0 } } }
  }
  async poll(id: string, epoch: string, after: number, signal?: AbortSignal): Promise<JsonObject> {
    const log = this.lookup(id, epoch)
    await this.refresh(log, signal)
    if (!Number.isSafeInteger(after) || after < -1 || after >= log.events.length) throw new Error('Bridge 历史游标失效，请重新打开会话')
    return { records: log.events.slice(after + 1).map(event => ({ type: 'event', event: event as unknown as JsonValue })) }
  }
  page(id: string, epoch: string, args: JsonObject): JsonObject {
    const log = this.lookup(id, epoch)
    return historyPage(log.events, Number(args['throughSeq']), args['beforeSeq'] === undefined ? undefined : Number(args['beforeSeq']), args['maxMessages'] === undefined ? undefined : Number(args['maxMessages']))
  }
  private lookup(id: string, epoch: string): Log {
    const log = this.logs.get(id)
    if (!log || log.epoch !== epoch || log.invalid) throw new Error('Bridge 历史已修订或缓存已释放，请切换后重新打开会话')
    log.touchedAt = Date.now()
    return log
  }
  private refresh(log: Log, signal?: AbortSignal): Promise<void> {
    if (log.pending) return log.pending
    log.pending = this.read(log, signal).finally(() => { log.pending = undefined })
    return log.pending
  }
  private async read(log: Log, signal?: AbortSignal): Promise<void> {
    const full = Date.now() - log.checkedAt >= 30_000
    const history = await readHistory(this.bridge, log.remoteId, full ? undefined : log.cursor, signal)
    const known = new Set<string>()
    for (const row of history.rows) {
      const id = str(row['eventId']); known.add(id)
      if (log.rows.has(id) && log.rows.get(id) !== JSON.stringify(row)) log.invalid = true
    }
    if (full && [...log.rows.keys()].some(id => !known.has(id))) log.invalid = true
    if (full && [...log.rows.keys()].some((id, index) => str(history.rows[index]?.['eventId']) !== id)) log.invalid = true
    if (log.invalid) throw new Error('Bridge 历史已原地修订，请切换后重新打开会话')
    const fresh = history.rows.filter(row => !log.rows.has(str(row['eventId'])))
    log.events.push(...projectRows(fresh, log.events, str(log.summary['model'], 'remote')))
    for (const row of fresh) log.rows.set(str(row['eventId']), JSON.stringify(row))
    log.cursor = history.cursor ?? log.cursor
    if (full) log.checkedAt = Date.now()
    log.touchedAt = Date.now()
  }
}
