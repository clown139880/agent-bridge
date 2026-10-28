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

describe('virtual session catalog', () => {
  it('sends only what changed since the client revision, and everything after a Host restart', async () => {
    const service = new AgentControlService(config())
    let rows = [{ sessionId: 'a', title: 'A', activityAt: 1 }, { sessionId: 'b', title: 'B', activityAt: 1 }]
    service.importTarget = { catalog: () => ({ groups: [{ big: 'x'.repeat(1000) }], sessions: rows }) } as never
    const call = (args: Record<string, unknown>) => service.dispatch({ domain: 'bridge', operation: 'virtual_catalog', args: args as never }) as Promise<Record<string, any>>
    const first = await call({})
    expect(first.full).toBe(true); expect(first.sessions).toHaveLength(2); expect(first).not.toHaveProperty('groups')
    const quiet = await call({ since: first.rev, epoch: first.epoch })
    expect(quiet.sessions).toEqual([]); expect(quiet.removed).toEqual([]); expect(quiet).not.toHaveProperty('order')
    rows = [{ ...rows[0]!, activityAt: 2 }]
    const change = await call({ since: quiet.rev, epoch: quiet.epoch })
    expect(change.sessions.map((row: any) => row.sessionId)).toEqual(['a']); expect(change.removed).toHaveLength(1)
    expect(change.order).toHaveLength(1)
    expect((await call({ since: change.rev, epoch: 'old-host' })).full).toBe(true)
    service.dispose()
  })
})
