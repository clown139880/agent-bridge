import type { JsonObject, JsonValue } from '../types.js'

export type RecordValue = JsonObject
export function asRecord(value: JsonValue | undefined): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
export function asArray(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : [] }
export function str(value: JsonValue | undefined, fallback = '—'): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback }
export function sessionTitle(session: JsonObject): string {
  const title = str(session['title'], '').trim()
  if (title) return title
  const summary = str(session['promptSummary'], '').replace(/\s+/g, ' ').trim()
  if (summary) {
    const points = Array.from(summary)
    return points.length <= 56 ? summary : `${points.slice(0, 56).join('')}…`
  }
  return `${str(session['projectName'], 'Session')} · ${str(session['sessionId'], 'unknown').slice(0, 8)}`
}
export function requiredId(value: JsonObject, key: string): string {
  const id = value[key]
  if (typeof id !== 'string' || !id) throw new Error(`Bridge response is missing ${key}.`)
  return id
}
export function readPage(value: JsonValue, idKey: string) {
  const page = asRecord(value)
  if (!Array.isArray(page['data']) || typeof page['hasMore'] !== 'boolean') throw new Error('Invalid Bridge page.')
  const data = page['data'].map(item => { const row = asRecord(item); requiredId(row, idKey); return row })
  const cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : null
  if (page['hasMore'] && !cursor) throw new Error('Bridge page has more records but no cursor.')
  return { data, cursor, hasMore: page['hasMore'] }
}
export function mergeRecords(current: JsonObject[], incoming: JsonObject[], idKey: string): JsonObject[] {
  const rows = new Map(current.map(row => [requiredId(row, idKey), row]))
  for (const row of incoming) rows.set(requiredId(row, idKey), row)
  return [...rows.values()]
}

/** Resolve the model used by the most recent retained turn. */
export function latestSessionModel(events: JsonObject[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const payload = asRecord(events[index]?.['payload'])
    const model = payload['model']
    if (typeof model === 'string' && model.trim()) return model.trim()
    const rerouted = payload['toModel']
    if (typeof rerouted === 'string' && rerouted.trim()) return rerouted.trim()
  }
  return ''
}

/** Transport event identity and item identity are separate: history hydration can repeat a settled item. */
export function projectEvents(events: JsonObject[]): JsonObject[] {
  const result = new Map<string, JsonObject>()
  for (const event of events) {
    const type = str(event['type'])
    const payload = asRecord(event['payload'])
    // Native DSH keeps structural turn boundaries out of the settled transcript.
    if (type === 'context.updated' || type === 'turn.started' || (type === 'turn.completed' && !payload['summary'] && !payload['error'])) continue
    const settled = ['message.completed', 'command.completed', 'file_change.completed'].includes(type)
    const key = settled && typeof event['itemId'] === 'string' && typeof event['turnId'] === 'string'
      ? JSON.stringify([event['sessionId'], event['turnId'], event['itemId'], event['type']])
      : requiredId(event, 'eventId')
    result.set(key, event)
  }
  return [...result.values()]
}

export type SessionSort = 'createdAt' | 'updatedAt'
const timestamp = (value: JsonValue | undefined): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
export function groupSessions(sessions: JsonObject[], query: string, grouped: boolean, attention: boolean, sort: SessionSort = 'updatedAt') {
  const needle = query.trim().toLocaleLowerCase()
  const groups = new Map<string, { key: string; title: string; worker: string; sessions: JsonObject[] }>()
  const ordered = [...sessions].sort((a, b) => timestamp(b[sort]) - timestamp(a[sort]) || timestamp(b['createdAt']) - timestamp(a['createdAt']) || timestamp(b['updatedAt']) - timestamp(a['updatedAt']) || requiredId(a, 'sessionId').localeCompare(requiredId(b, 'sessionId')))
  for (const row of ordered) {
    if (attention && !['waiting_for_approval', 'waiting_for_input', 'error'].includes(str(row['status']))) continue
    if (needle && ![sessionTitle(row), str(row['workspace'], ''), str(row['workerId'], '')].some(text => text.toLocaleLowerCase().includes(needle))) continue
    // Keep source paths exact; platform-aware canonicalization belongs to the source.
    const key = grouped ? JSON.stringify([row['workerId'], row['workspace']]) : 'all'
    let group = groups.get(key)
    if (!group) { group = { key, title: grouped ? str(row['workspace'], 'No workspace') : 'Recent sessions', worker: grouped ? str(row['workerId']) : '', sessions: [] }; groups.set(key, group) }
    group.sessions.push(row)
  }
  const priority = (rows: JsonObject[]): number => rows.some(row => ['active', 'waiting_for_approval', 'waiting_for_input', 'error'].includes(str(row['status']))) ? 1 : 0
  return [...groups.values()].sort((a, b) => priority(b.sessions) - priority(a.sessions)
    || Math.max(...b.sessions.map(row => timestamp(row[sort]))) - Math.max(...a.sessions.map(row => timestamp(row[sort]))))
}
