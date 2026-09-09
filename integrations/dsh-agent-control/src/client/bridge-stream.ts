import type { BridgeStreamEvent, BridgeStreamEventType, JsonObject, JsonValue } from '../types.js'

const STREAM_PATH = '/api/agent-control.stream'
const TYPES = new Set<BridgeStreamEventType>([
  'worker.upserted', 'worker.offline', 'session.upserted', 'session.updated', 'session.deleted',
  'session.event.appended', 'approval.upserted', 'user_input.upserted', 'action.updated',
])

export class BridgeStreamError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message) }
}

const object = (value: JsonValue | undefined): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined

function event(value: unknown): BridgeStreamEvent {
  const row = object(value as JsonValue)
  const resource = object(row?.['resource'])
  if (!row || typeof row['cursor'] !== 'string' || typeof row['eventId'] !== 'string' || typeof row['type'] !== 'string' ||
    !TYPES.has(row['type'] as BridgeStreamEventType) || typeof row['timestamp'] !== 'number' || !resource ||
    typeof resource['kind'] !== 'string' || typeof resource['id'] !== 'string' ||
    !(typeof row['sessionId'] === 'string' || row['sessionId'] === null) || row['data'] === undefined) {
    throw new BridgeStreamError('bridge_protocol_error', 'Agent Bridge returned an invalid stream event.')
  }
  return row as unknown as BridgeStreamEvent
}

async function responseError(response: Response): Promise<BridgeStreamError> {
  const body = await response.json().catch(() => undefined) as JsonValue | undefined
  const detail = object(object(body)?.['error'])
  const code = typeof detail?.['code'] === 'string' ? detail['code'] : `http_${response.status}`
  const message = typeof detail?.['message'] === 'string' ? detail['message'] : `Agent Bridge stream returned HTTP ${response.status}.`
  return new BridgeStreamError(code, message, response.status)
}

export async function* openBridgeStream(cursor: string | undefined, signal: AbortSignal, onOpen?: () => void): AsyncIterable<BridgeStreamEvent> {
  const url = new URL(STREAM_PATH, window.location.origin)
  if (cursor) url.searchParams.set('cursor', cursor)
  const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal, cache: 'no-store' })
  if (!response.ok) throw await responseError(response)
  if (!response.body) throw new BridgeStreamError('bridge_protocol_error', 'Agent Bridge stream has no response body.')
  onOpen?.()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      buffer = `${buffer}${decoder.decode(chunk.value, { stream: !chunk.done })}`.replace(/\r\n?/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const lines = block.split('\n')
        const kind = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (kind === 'bridge.event' && data) yield event(JSON.parse(data) as unknown)
        boundary = buffer.indexOf('\n\n')
      }
      if (chunk.done) break
    }
  } finally { reader.releaseLock() }
}
