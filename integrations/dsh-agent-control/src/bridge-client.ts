import { randomUUID } from 'node:crypto'
import { ControlError } from './errors.js'
import { mockSnapshot } from './mock.js'
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
      case 'snapshot': return this.request('GET', `/snapshot?${query(args, ['sessionLimit'])}`, undefined, undefined, signal)
      case 'sessions': return this.request('GET', `/sessions?${query(args, ['workerId', 'status', 'workspace', 'taskId', 'runId', 'limit', 'cursor'])}`, undefined, undefined, signal)
      case 'session': return this.request('GET', `/sessions/${this.segment(textArg(args, 'sessionId')!)}`, undefined, undefined, signal)
      case 'session_events': {
        const id = this.segment(textArg(args, 'sessionId')!)
        return this.request('GET', `/sessions/${id}/events?${query(args, ['after', 'limit', 'type'])}`, undefined, undefined, signal)
      }
      case 'create_session': return this.write('/sessions', this.pick(args, ['workerId', 'workspace', 'input', 'model']), signal)
      case 'submit_turn': {
        const id = this.segment(textArg(args, 'sessionId')!)
        return this.write(`/sessions/${id}/turns`, this.pick(args, ['input', 'delivery', 'expectedTurnId', 'model']), signal)
      }
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

  private async write(path: string, body: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    return this.request('POST', path, body, randomUUID(), signal)
  }

  private async request(method: 'GET' | 'POST', path: string, body?: JsonObject, idempotencyKey?: string, outerSignal?: AbortSignal): Promise<JsonValue> {
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
    switch (call.operation) {
      case 'workers': return { workers: mockSnapshot.workers, streamCursor: mockSnapshot.streamCursor ?? 'mock:1' } as unknown as JsonValue
      case 'snapshot': return mockSnapshot as unknown as JsonValue
      case 'sessions': return { data: mockSnapshot.sessions, nextCursor: null, hasMore: false, streamCursor: 'mock:1' } as unknown as JsonValue
      case 'session': return mockSnapshot.sessions.find(item => item.id === args['sessionId']) as unknown as JsonValue ?? null
      case 'session_events': return { data: [], nextCursor: null, hasMore: false, streamCursor: 'mock:1' }
      case 'approvals': return { data: mockSnapshot.approvals, nextCursor: null, hasMore: false, streamCursor: 'mock:1' } as unknown as JsonValue
      case 'approval': return mockSnapshot.approvals.find(item => item.id === args['approvalId']) as unknown as JsonValue ?? null
      case 'user_input': return { data: mockSnapshot.userInput, nextCursor: null, hasMore: false, streamCursor: 'mock:1' } as unknown as JsonValue
      case 'user_input_request': return mockSnapshot.userInput.find(item => item.id === args['requestId']) as unknown as JsonValue ?? null
      case 'respond_user_input': throw new ControlError('secret_input_unsupported', 'Mock transport does not persist or relay secret input.', 409)
      default: return {
        actionId: `mock-${randomUUID()}`, kind: call.operation, status: 'succeeded',
        sessionId: typeof args['sessionId'] === 'string' ? args['sessionId'] : null,
        turnId: null, ...(call.operation === 'submit_turn' ? { resolvedAction: 'start_turn' } : {}),
      }
    }
  }
}
