import { randomUUID } from 'node:crypto'
import { ControlError } from './errors.js'
import { mockSessionEvents, mockSnapshot } from './mock.js'
import type { BridgeCall, JsonObject, JsonValue, Snapshot } from './types.js'

export interface BridgeConfig {
  mode: 'live' | 'mock'
  origin: string
  tokenEnv: string
  token?: string
  timeoutMs: number
}

function textArg(args: JsonObject, key: string, required = true): string | undefined {
  const value = args[key]
  if (typeof value === 'string' && value.trim()) return value
  if (!required && value === undefined) return undefined
  throw new ControlError('invalid_parameter', `${key} must be a non-empty string.`, 400)
}

function query(args: JsonObject, keys: readonly string[]): URLSearchParams {
  const output = new URLSearchParams()
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output.set(key, String(value))
    }
  }
  return output
}

export class BridgeClient {
  private readonly token: string | undefined
  private readonly resolvedMockApprovals = new Set<string>()
  private readonly mockCreatedSessions: Snapshot['sessions'] = []
  private readonly mockSubmittedEvents: JsonObject[] = []
  private readonly mockDeletedSessions = new Set<string>()

  constructor(private readonly config: BridgeConfig) {
    this.token = config.token ?? process.env[config.tokenEnv]
    if (config.mode === 'live' && !this.token) {
      throw new ControlError('bridge_token_missing', `Bridge token environment variable ${config.tokenEnv} is not set.`, 500)
    }
  }

  async call(call: BridgeCall, signal?: AbortSignal): Promise<JsonValue> {
    if (this.config.mode === 'mock') return this.mock(call)
    const args = call.args ?? {}
    switch (call.operation) {
      case 'workers': return this.request('GET', '/workers', undefined, undefined, signal)
      case 'delete_worker': return this.request('DELETE', `/workers/${this.segment(textArg(args, 'workerId')!)}`, {}, randomUUID(), signal)
      case 'models': return this.request('GET', `/workers/${this.segment(textArg(args, 'workerId')!)}/models`, undefined, undefined, signal)
      case 'snapshot': return this.request('GET', `/snapshot?${query(args, ['sessionLimit'])}`, undefined, undefined, signal)
      case 'sessions': return this.request('GET', `/sessions?${query(args, ['workerId', 'status', 'workspace', 'taskId', 'runId', 'segment', 'dayStart', 'sort', 'order', 'limit', 'cursor'])}`, undefined, undefined, signal)
      case 'session': return this.request('GET', `/sessions/${this.segment(textArg(args, 'sessionId')!)}`, undefined, undefined, signal)
      case 'delete_session': return this.request('DELETE', `/sessions/${this.segment(textArg(args, 'sessionId')!)}`, {}, randomUUID(), signal)
      case 'session_events': {
        const id = this.segment(textArg(args, 'sessionId')!)
        return this.request('GET', `/sessions/${id}/events?${query(args, ['after', 'before', 'tail', 'limit', 'type'])}`, undefined, undefined, signal)
      }
      case 'create_session': return this.write('/sessions', this.pick(args, ['workerId', 'workspace', 'input', 'model', 'attachments']), signal)
      case 'submit_turn': {
        const id = this.segment(textArg(args, 'sessionId')!)
        return this.write(`/sessions/${id}/turns`, this.pick(args, ['input', 'delivery', 'expectedTurnId', 'model', 'reasoningEffort', 'attachments']), signal)
      }
      case 'upload': return this.write('/attachments', this.pick(args, ['filename', 'content', 'mimeType']), signal)
      case 'download': return this.download(`/attachments/${this.segment(textArg(args, 'attachmentId')!)}`, signal)
      case 'interrupt_turn': {
        const id = this.segment(textArg(args, 'sessionId')!)
        return this.write(`/sessions/${id}/interrupt`, this.pick(args, ['expectedTurnId']), signal)
      }
      case 'approvals': return this.request('GET', `/approvals?${query(args, ['sessionId', 'status', 'limit', 'cursor'])}`, undefined, undefined, signal)
      case 'approval': return this.request('GET', `/approvals/${this.segment(textArg(args, 'approvalId')!)}`, undefined, undefined, signal)
      case 'resolve_approval': {
        const id = this.segment(textArg(args, 'approvalId')!)
        return this.write(`/approvals/${id}/decision`, this.pick(args, ['choice']), signal)
      }
      case 'user_input': return this.request('GET', `/user-input?${query(args, ['sessionId', 'status', 'limit', 'cursor'])}`, undefined, undefined, signal)
      case 'user_input_request': return this.request('GET', `/user-input/${this.segment(textArg(args, 'requestId')!)}`, undefined, undefined, signal)
      case 'respond_user_input': {
        const id = this.segment(textArg(args, 'requestId')!)
        return this.write(`/user-input/${id}/response`, this.pick(args, ['answers']), signal)
      }
      case 'action': return this.request('GET', `/actions/${this.segment(textArg(args, 'actionId')!)}`, undefined, undefined, signal)
    }
  }

  async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    return await this.call({ operation: 'snapshot', args: { sessionLimit: 100 } }, signal) as unknown as Snapshot
  }

  async stream(cursor: string | undefined, signal: AbortSignal): Promise<Response> {
    if (this.config.mode === 'mock') return new Response(JSON.stringify({ error: { code: 'stream_unavailable', message: 'Mock Bridge streaming is unavailable.' } }), { status: 501, headers: { 'content-type': 'application/json' } })
    const url = new URL('/api/v1/stream', this.config.origin)
    if (cursor) url.searchParams.set('cursor', cursor)
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${this.token!}`, accept: 'text/event-stream' }, signal, cache: 'no-store' })
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) {
      if (signal.aborted) throw error
      return Response.json({ error: { code: 'bridge_unavailable', message: error instanceof Error ? error.message : 'Agent Bridge unavailable.', retryable: true } }, { status: 503 })
    }
  }

  private async write(path: string, body: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    return this.request('POST', path, body, randomUUID(), signal)
  }

  /** Fetch binary attachment bytes and return them base64-encoded for the renderer. */
  private async download(path: string, outerSignal?: AbortSignal): Promise<JsonValue> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout
    let response: Response
    try {
      response = await fetch(new URL(`/api/v1${path}`, this.config.origin), { headers: { authorization: `Bearer ${this.token!}` }, signal, cache: 'no-store' })
    } catch (error) {
      if (signal.aborted) throw new ControlError('bridge_timeout', 'Agent Bridge request timed out or was cancelled.', 504, true)
      throw new ControlError('bridge_unavailable', error instanceof Error ? error.message : 'Agent Bridge unavailable.', 503, true)
    }
    if (!response.ok) throw new ControlError('attachment_unavailable', `Agent Bridge returned HTTP ${response.status}.`, response.status)
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? 'application/octet-stream'
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64')
    return { mimeType, base64 }
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: JsonObject, idempotencyKey?: string, outerSignal?: AbortSignal): Promise<JsonValue> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token!}`,
      accept: 'application/json',
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey
    let response: Response
    try {
      response = await fetch(new URL(`/api/v1${path}`, this.config.origin), {
        method, headers, signal, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      if (signal.aborted) throw new ControlError('bridge_timeout', 'Agent Bridge request timed out or was cancelled.', 504, true)
      throw new ControlError('bridge_unavailable', error instanceof Error ? error.message : 'Agent Bridge unavailable.', 503, true)
    }
    const value = await response.json().catch(() => undefined) as JsonValue | undefined
    if (!response.ok) {
      const envelope = value as { error?: { code?: unknown; message?: unknown; retryable?: unknown } | string } | undefined
      const detail = typeof envelope?.error === 'object' ? envelope.error : undefined
      const code = typeof detail?.code === 'string' ? detail.code : typeof envelope?.error === 'string' ? envelope.error : 'bridge_error'
      const message = typeof detail?.message === 'string' ? detail.message : `Agent Bridge returned HTTP ${response.status}.`
      throw new ControlError(code, message, response.status, detail?.retryable === true)
    }
    if (value === undefined) throw new ControlError('bridge_protocol_error', 'Agent Bridge returned non-JSON data.', 502)
    return value
  }

  private segment(value: string): string { return encodeURIComponent(value) }

  private pick(args: JsonObject, keys: readonly string[]): JsonObject {
    const output: JsonObject = {}
    for (const key of keys) if (args[key] !== undefined) output[key] = args[key]!
    return output
  }

  private mock(call: BridgeCall): JsonValue {
    const args = call.args ?? {}
    const sessions = [...this.mockCreatedSessions, ...mockSnapshot.sessions].filter(item => !this.mockDeletedSessions.has(item.sessionId))
    const pending = mockSnapshot.approvals.filter(item => !this.resolvedMockApprovals.has(item.id))
    const page = (rows: JsonValue[], eventPage = false): JsonValue => {
      const value = args[eventPage ? 'after' : 'cursor']
      const limit = typeof args['limit'] === 'number' ? Math.max(1, Math.min(500, args['limit'])) : 100
      if (eventPage && args['tail'] === true) {
        const before = args['before']
        const end = typeof before === 'string' && /^mock:\d+$/.test(before) ? Number(before.slice(5)) : rows.length
        const start = Math.max(0, end - limit)
        return { data: rows.slice(start, end), nextCursor: start > 0 ? `mock:${start}` : null, hasMore: start > 0, streamCursor: 'mock:1' }
      }
      const offset = typeof value === 'string' && /^mock:\d+$/.test(value) ? Number(value.slice(5)) : 0
      const data = rows.slice(offset, offset + limit)
      const next = offset + data.length
      return { data, nextCursor: next < rows.length || eventPage ? `mock:${next}` : null, hasMore: next < rows.length, streamCursor: 'mock:1' }
    }
    switch (call.operation) {
      case 'workers': return { workers: mockSnapshot.workers, streamCursor: mockSnapshot.streamCursor ?? 'mock:1' } as unknown as JsonValue
      case 'models': return { models: [
        { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' }, { reasoningEffort: 'high', description: 'More reasoning' }] },
        { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra' },
      ] } as unknown as JsonValue
      case 'snapshot': return { ...mockSnapshot, approvals: pending } as unknown as JsonValue
      case 'sessions': {
        const dayStart = typeof args['dayStart'] === 'number' ? args['dayStart'] : 0
        const attention = new Set(['creating', 'active', 'waiting_for_approval', 'waiting_for_input', 'error'])
        const filtered = sessions.filter(item => (!args['workerId'] || item.workerId === args['workerId'])
          && (!args['workspace'] || item.workspace === args['workspace']) && (!args['status'] || item.status === args['status'])
          && (args['segment'] !== 'recent' || item.updatedAt >= dayStart || attention.has(item.status))
          && (args['segment'] !== 'history' || (item.updatedAt < dayStart && !attention.has(item.status))))
        return page(filtered as unknown as JsonValue[])
      }
      case 'create_session': {
        const workerId = textArg(args, 'workerId')!
        const workspace = textArg(args, 'workspace')!
        if (mockSnapshot.workers.find(worker => worker.id === workerId)?.status !== 'online') throw new ControlError('worker_offline', 'Worker offline', 409)
        const sessionId = `mock-session-${randomUUID()}`
        this.mockCreatedSessions.unshift({ sessionId, workerId, workspace, title: 'New conversation', status: 'idle', createdAt: Date.now(), updatedAt: Date.now() })
        return { actionId: `mock-${randomUUID()}`, kind: 'create_session', status: 'succeeded', sessionId }
      }
      case 'session': {
        const session = sessions.find(item => item.sessionId === args['sessionId'])
        return session ? { ...session, historyCompleteness: 'loaded-only', capabilities: mockSnapshot.workers.find(worker => worker.id === session.workerId)?.capabilities ?? [] } as unknown as JsonValue : null
      }
      case 'delete_session': {
        const sessionId = textArg(args, 'sessionId')!
        this.mockDeletedSessions.add(sessionId)
        return { actionId: `mock-${randomUUID()}`, kind: 'delete_session', status: 'succeeded', sessionId }
      }
      case 'session_events': return page([...mockSessionEvents, ...this.mockSubmittedEvents].filter(item => item['sessionId'] === args['sessionId']), true)
      case 'submit_turn': {
        const sessionId = textArg(args, 'sessionId')!
        const input = textArg(args, 'input')!
        const turnId = `mock-turn-${randomUUID()}`
        this.mockSubmittedEvents.push({ eventId: `mock-event-${randomUUID()}`, sessionId, turnId, timestamp: Date.now(), type: 'message.completed', payload: { role: 'user', text: input } })
        return { actionId: `mock-${randomUUID()}`, kind: 'submit_turn', status: 'succeeded', sessionId, turnId, resolvedAction: 'start_turn' }
      }
      case 'approvals': return page(pending.filter(item => !args['sessionId'] || item.sessionId === args['sessionId']) as unknown as JsonValue[])
      case 'approval': return mockSnapshot.approvals.find(item => item.id === args['approvalId']) as unknown as JsonValue ?? null
      case 'user_input': return { data: mockSnapshot.userInput, nextCursor: null, hasMore: false, streamCursor: 'mock:1' } as unknown as JsonValue
      case 'user_input_request': return mockSnapshot.userInput.find(item => item.id === args['requestId']) as unknown as JsonValue ?? null
      case 'respond_user_input': throw new ControlError('secret_input_unsupported', 'Mock transport does not persist or relay secret input.', 409)
      case 'resolve_approval': {
        this.resolvedMockApprovals.add(textArg(args, 'approvalId')!)
        return { actionId: `mock-${randomUUID()}`, status: 'succeeded', kind: call.operation }
      }
      default: return {
        actionId: `mock-${randomUUID()}`, kind: call.operation, status: 'succeeded',
        sessionId: typeof args['sessionId'] === 'string' ? args['sessionId'] : null,
        turnId: null,
      }
    }
  }
}
