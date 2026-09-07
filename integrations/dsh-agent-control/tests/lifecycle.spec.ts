import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

describe('Cordis lifecycle', () => {
  it('registers tools, prompt, route and disposes the shared service', async () => {
    const ctx = new Context()
    const serviceDispose = vi.spyOn(plugin.AgentControlService.prototype, 'dispose')
    const toolDisposers: Array<ReturnType<typeof vi.fn>> = []
    const routeDispose = vi.fn(async () => undefined)
    const promptDispose = vi.fn()
    ctx.provide('tools', { register: vi.fn(() => { const dispose = vi.fn(); toolDisposers.push(dispose); return dispose }) } as never)
    ctx.provide('systemPrompt', { section: vi.fn(() => promptDispose) } as never)
    ctx.provide('connection', { fetch: { register: vi.fn(() => routeDispose) } } as never)
    const fiber = await ctx.plugin(plugin, {
      bridge: { mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 },
      kanban: { mode: 'mock', board: 'test', permissionMode: 'read-only', author: 'test', hermesRoot: '/unused', hermesHome: '/unused', python: 'python3', timeoutMs: 1000 },
    })
    expect(toolDisposers).toHaveLength(24)
    expect(ctx.get('agentControl')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('agentControl')).toBeUndefined()
    expect(serviceDispose).toHaveBeenCalledOnce()
  })
})
