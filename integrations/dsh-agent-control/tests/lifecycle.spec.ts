import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { ControlError } from '../src/errors.js'

describe('Cordis lifecycle', () => {
  it('registers tools, prompt, route and disposes the shared service', async () => {
    const ctx = new Context()
    const serviceDispose = vi.spyOn(plugin.AgentControlService.prototype, 'dispose')
    const toolDisposers: Array<ReturnType<typeof vi.fn>> = []
    const routeDispose = vi.fn(async () => undefined)
    const rpcHandle = vi.fn(() => routeDispose)
    const promptDispose = vi.fn()
    ctx.provide('tools', { register: vi.fn(() => { const dispose = vi.fn(); toolDisposers.push(dispose); return dispose }) } as never)
    ctx.provide('systemPrompt', { section: vi.fn(() => promptDispose) } as never)
    ctx.provide('connection', { rpc: { handle: rpcHandle } } as never)
    const fiber = await ctx.plugin(plugin, {
      bridge: { mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 },
      kanban: { mode: 'mock', board: 'test', permissionMode: 'read-only', author: 'test', hermesRoot: '/unused', hermesHome: '/unused', python: 'python3', timeoutMs: 1000 },
    })
    expect(toolDisposers).toHaveLength(24)
    expect(rpcHandle).toHaveBeenCalledOnce()
    expect(rpcHandle).toHaveBeenCalledWith('/agent-control', expect.any(Function), { authority: 'trusted-host' })
    expect(ctx.get('agentControl')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('agentControl')).toBeUndefined()
    expect(serviceDispose).toHaveBeenCalledOnce()
  })

  it('normalizes domain failures to Connection transport error codes', async () => {
    const dispatch = vi.fn().mockRejectedValue(new ControlError('bridge_unavailable', 'fetch failed', 503, true))
    const handler = plugin.createAgentControlRpcHandler({ dispatch } as never)
    const result = await handler('dispatch', { domain: 'overview', operation: 'snapshot' }, new AbortController().signal)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: JSON.stringify({ ok: false, error: { code: 'bridge_unavailable', message: 'fetch failed', status: 503, retryable: true } }),
        details: {},
      },
    })
  })

  it('uses bad-request only for invalid RPC payloads', async () => {
    const handler = plugin.createAgentControlRpcHandler({ dispatch: vi.fn() } as never)
    const result = await handler('dispatch', {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('bad-request')
  })
})
