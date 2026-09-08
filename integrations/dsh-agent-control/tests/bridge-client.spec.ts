import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, ControlError } from '../src/index.js'

afterEach(() => { vi.unstubAllGlobals(); delete process.env['TEST_BRIDGE_TOKEN'] })

describe('BridgeClient', () => {
  it('keeps bearer credentials host-side and adds idempotency to writes', async () => {
    process.env['TEST_BRIDGE_TOKEN'] = 'host-only-secret'
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: 'Bearer host-only-secret', 'idempotency-key': expect.any(String) })
      return Response.json({ actionId: 'a1', status: 'accepted', kind: 'submit_turn', sessionId: 's1', turnId: null })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new BridgeClient({ mode: 'live', origin: 'http://bridge.invalid', tokenEnv: 'TEST_BRIDGE_TOKEN', timeoutMs: 1000 })
    await client.call({ operation: 'submit_turn', args: { sessionId: 's1', input: 'continue', delivery: 'auto', model: 'deepseek-chat' } })
    const serialized = JSON.stringify(fetchMock.mock.calls)
    expect(serialized).toContain('/api/v1/sessions/s1/turns')
    expect(serialized).toContain('deepseek-chat')
  })

  it('maps structured Bridge errors without exposing request headers', async () => {
    process.env['TEST_BRIDGE_TOKEN'] = 'secret-value'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'turn_changed', message: 'refresh', retryable: false } }, { status: 409 })))
    const client = new BridgeClient({ mode: 'live', origin: 'http://bridge.invalid', tokenEnv: 'TEST_BRIDGE_TOKEN', timeoutMs: 1000 })
    await expect(client.call({ operation: 'interrupt_turn', args: { sessionId: 's1' } })).rejects.toMatchObject({ code: 'turn_changed', status: 409 })
  })

  it('fails closed when a live token is absent', () => {
    expect(() => new BridgeClient({ mode: 'live', origin: 'http://bridge.invalid', tokenEnv: 'TEST_BRIDGE_TOKEN', timeoutMs: 1000 })).toThrow(ControlError)
  })
})
