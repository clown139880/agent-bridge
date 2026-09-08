import { describe, expect, it } from 'vitest'
import { AgentControlService, ControlError } from '../src/index.js'

function config(permissionMode: 'read-only' | 'orchestrator' | 'operator' = 'orchestrator') {
  return {
    bridge: { mode: 'mock' as const, origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 },
    kanban: { mode: 'mock' as const, board: 'test', permissionMode, author: 'test', hermesRoot: '/unused', hermesHome: '/unused', python: 'python3', timeoutMs: 1000 },
  }
}

describe('AgentControlService', () => {
  it('assembles one consistent overview from shared clients', async () => {
    const service = new AgentControlService(config())
    const result = await service.dispatch({ domain: 'overview', operation: 'snapshot' }) as Record<string, unknown>
    expect(result.needsAttention).toBe(1)
    expect(result).toHaveProperty('bridge')
    expect(result).toHaveProperty('board')
    service.dispose()
  })

  it('allows the native model selector to request a worker catalog', async () => {
    const service = new AgentControlService(config())
    const result = await service.dispatch({ domain: 'bridge', operation: 'models', args: { workerId: 'codex@hal' } }) as { models: unknown[] }
    expect(result.models).toHaveLength(2)
    service.dispose()
  })

  it('enforces Kanban permission modes before transport', async () => {
    const readOnly = new AgentControlService(config('read-only'))
    await expect(readOnly.dispatch({ domain: 'kanban', operation: 'comment', args: { taskId: 't1', body: 'x' } })).rejects.toMatchObject({ code: 'kanban_forbidden' })
    const orchestrator = new AgentControlService(config('orchestrator'))
    await expect(orchestrator.dispatch({ domain: 'kanban', operation: 'reclaim', args: { taskId: 't1' } })).rejects.toMatchObject({ code: 'kanban_forbidden' })
    await expect(orchestrator.dispatch({ domain: 'kanban', operation: 'request_review', args: { taskId: 't1', summary: 'x', force: true } })).rejects.toMatchObject({ code: 'kanban_forbidden' })
    await expect(orchestrator.dispatch({ domain: 'kanban', operation: 'create', args: { title: 'x', assignee: 'invented-profile' } })).rejects.toMatchObject({ code: 'invalid_assignee' })
    readOnly.dispose(); orchestrator.dispose()
  })

  it('rejects unknown operations', async () => {
    const service = new AgentControlService(config())
    await expect(service.dispatch({ domain: 'bridge', operation: 'delete_everything' })).rejects.toBeInstanceOf(ControlError)
    service.dispose()
  })
})
