import { createHash, randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { BridgeClient } from '../bridge-client.js'
import type { JsonObject, JsonValue } from '../types.js'
import type { NativeEvent } from '../agent-bridge-provider/dsh-compat.js'
import { readHistory } from '../agent-bridge-provider/import-target.js'
import { projectNativeEvents, record, sameUserText, str } from '../agent-bridge-provider/mapping.js'
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
  remoteId: string; epoch: string; events: NativeEvent[]; rows: Set<string>; cursor?: string | undefined;
  summary: JsonObject; touchedAt: number; invalid: boolean; pending?: Promise<void> | undefined
  /** Last session viewRevision seen; unchanged means nothing to read. */
  revision: number
  /**
   * Revision accounting for in-place revisions: every stored event and every
   * in-place revision moves the session's view revision by one. From a baseline
   * (revision, highest event id) read together, revisions beyond the events read
   * since then are in-place revisions of history already shown.
   */
  baseline?: { revision: number; high: number } | undefined
  rowsAfterBaseline: number
}
const PAGE = 500
const rowId = (row: JsonObject) => Number(/^e:(\d+)$/.exec(str(row['cursor']))?.[1] ?? 0)

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
      log = { remoteId: str(summary['sessionId']), epoch: randomUUID(), events: [], rows: new Set(), summary, touchedAt: Date.now(), invalid: false,
        revision: -1, rowsAfterBaseline: 0 }
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
  /** Cheap when nothing changed: one session read. Never re-reads history already held. */
  private async read(log: Log, signal?: AbortSignal): Promise<void> {
    const session = record(await this.bridge.call({ operation: 'session', args: { sessionId: log.remoteId } }, signal))
    const revision = typeof session['viewRevision'] === 'number' ? session['viewRevision'] : undefined
    log.touchedAt = Date.now()
    if (revision !== undefined && revision === log.revision) return
    if (revision !== undefined && !log.baseline && !log.rows.size) log.baseline = await this.baseline(log.remoteId, revision, signal)
    const history = await readHistory(this.bridge, log.remoteId, log.cursor, signal, PAGE)
    const fresh = history.rows.filter(row => !log.rows.has(str(row['eventId'])))
    if (log.baseline) log.rowsAfterBaseline += fresh.filter(row => rowId(row) > log.baseline!.high).length
    if (revision !== undefined && log.baseline && revision - log.baseline.revision > log.rowsAfterBaseline) log.invalid = true
    if (log.invalid) throw new Error('Bridge 历史已原地修订，请切换后重新打开会话')
    const projected = projectRows(fresh, log.events, str(log.summary['model'], 'remote'))
    this.claimEchoes(log.remoteId, fresh, projected)
    log.events.push(...projected)
    for (const row of fresh) log.rows.add(str(row['eventId']))
    log.cursor = history.cursor ?? log.cursor
    if (revision !== undefined) log.revision = revision
  }
  /** Prompts sent from DSH whose Bridge echo has not arrived yet, by remote session. */
  private readonly sent = new Map<string, Array<{ requestId: string; text: string; time: number; actionId?: string }>>()
  /** Submit a prompt typed in the native composer to the Bridge session. */
  async prompt(id: string, entries: JsonObject[], args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const remoteId = str(this.resolve(id, entries)['sessionId']), text = str(args['text'])
    const pending = { requestId: str(args['requestId']), text, time: Date.now() } as { requestId: string; text: string; time: number; actionId?: string }
    // Registered before submitting: the echo can arrive before the receipt.
    const list = this.sent.get(remoteId) ?? []; list.push(pending); this.sent.set(remoteId, list.slice(-20))
    const model = str(args['model'])
    const attachments = Array.isArray(args['attachments']) ? args['attachments'] : []
    const receipt = record(await this.bridge.call({ operation: 'submit_turn', args: { sessionId: remoteId, input: text, delivery: 'auto',
      ...(attachments.length ? { attachments } : {}),
      ...(model && model !== 'remote' ? { model } : {}), ...(str(args['reasoningEffort']) ? { reasoningEffort: str(args['reasoningEffort']) } : {}) } }, signal))
    if (receipt['status'] === 'failed') {
      this.sent.set(remoteId, (this.sent.get(remoteId) ?? []).filter(item => item !== pending))
      throw new Error(str(record(record(receipt['error'])['error'])['message'], str(record(receipt['error'])['message'], 'Bridge 拒绝了这条消息')))
    }
    pending.actionId = str(receipt['actionId'])
    return { accepted: true }
  }
  /** Interrupt the Bridge session's running turn. */
  async cancel(id: string, entries: JsonObject[], signal?: AbortSignal): Promise<JsonObject> {
    const remoteId = str(this.resolve(id, entries)['sessionId'])
    const session = record(await this.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, signal))
    const turn = str(session['activeTurnId'])
    const receipt = record(await this.bridge.call({ operation: 'interrupt_turn', args: { sessionId: remoteId, ...(turn ? { expectedTurnId: turn } : {}) } }, signal))
    if (receipt['status'] === 'failed') throw new Error(str(record(receipt['error'])['message'], '中断失败'))
    return { accepted: true }
  }
  /**
   * Tag Bridge's echo of a prompt sent from DSH with its requestId (`source.rpcId`): the native
   * composer retires its local copy only on that. By action id when the worker names it in the
   * event id, otherwise by text sent around then.
   */
  private claimEchoes(remoteId: string, rows: readonly JsonObject[], events: NativeEvent[]): void {
    const pending = this.sent.get(remoteId)
    if (!pending?.length) return
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const eventId = str(event.data['id']).replace(/^bridge:/, '')
      const row = rows.find(item => str(item['eventId']) === eventId)
      if (!row) continue
      const at = Number(row['timestamp']) || Date.now(), text = str(record(row['payload'])['text'])
      const match = pending.find(item => item.actionId && eventId.includes(`:action:${item.actionId}:`))
        ?? pending.find(item => at >= item.time - 120_000 && at <= item.time + 6 * 3600_000 && sameUserText(text, item.text))
      if (!match) continue
      event.data = { ...event.data, source: { kind: 'user', rpcId: match.requestId } }
      pending.splice(pending.indexOf(match), 1)
    }
  }
  /** The revision and highest event id at one instant (Control Plane 0.7.25+); none from older servers. */
  private async baseline(sessionId: string, since: number, signal?: AbortSignal): Promise<Log['baseline']> {
    try {
      const changes = record(await this.bridge.call({ operation: 'session_view_changes', args: { sessionId, since, rawAfter: 0 } }, signal))
      const raw = record(changes['raw'])
      return changes['hasMore'] === false && typeof changes['toRevision'] === 'number' && typeof raw['through'] === 'number'
        ? { revision: changes['toRevision'], high: raw['through'] } : undefined
    } catch { return undefined }
  }
}
