import { describe, expect, it } from 'vitest'
import { AgentControlService, ControlError } from '../src/index.js'

function config() {
  return {
    bridge: { mode: 'mock' as const, origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 },
  }
}

describe('AgentControlService', () => {
  it('assembles one consistent overview from shared clients', async () => {
    const service = new AgentControlService(config())
    const result = await service.dispatch({ domain: 'overview', operation: 'snapshot' }) as Record<string, unknown>
    expect(result.needsAttention).toBe(1)
    expect(result).toHaveProperty('bridge')
    service.dispose()
  })

  it('allows the native model selector to request a worker catalog', async () => {
    const service = new AgentControlService(config())
    const result = await service.dispatch({ domain: 'bridge', operation: 'models', args: { workerId: 'codex@hal' } }) as { models: unknown[] }
    expect(result.models).toHaveLength(2)
    service.dispose()
  })

  it('rejects unknown operations', async () => {
    const service = new AgentControlService(config())
    await expect(service.dispatch({ domain: 'bridge', operation: 'delete_everything' })).rejects.toBeInstanceOf(ControlError)
    service.dispose()
  })
})
