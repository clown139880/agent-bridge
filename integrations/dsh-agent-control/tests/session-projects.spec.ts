import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/client/session-store.js'
import { groupSessions } from '../src/client/session-model.js'
import { BridgeClient } from '../src/bridge-client.js'

describe('project sessions', () => {
  it('sorts projects and rows by newest creation, breaking connection-time ties by creation', () => {
    const rows = [
      { sessionId: 'a', workspace: '/old', workerId: 'w', createdAt: 1, updatedAt: 100 },
      { sessionId: 'b', workspace: '/new', workerId: 'w', createdAt: 80, updatedAt: 100 },
      { sessionId: 'c', workspace: '/new', workerId: 'w', createdAt: 30, updatedAt: 100 },
    ]
    for (const sort of ['createdAt', 'updatedAt'] as const) {
      const groups = groupSessions(rows, '', true, false, sort)
      expect(groups.map(group => group.title)).toEqual(['/new', '/old'])
      expect(groups[0]?.sessions.map(row => row['sessionId'])).toEqual(['b', 'c'])
    }
  })

  it('creates an empty conversation in the selected project and selects the confirmed session', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const writes: unknown[] = []
    const store = new SessionStore(async (operation, args) => {
      if (operation === 'create_session') writes.push(args)
      return client.call({ operation, ...(args ? { args } : {}) })
    })
    await store.loadSessions(); await store.loadWorkers()
    await store.createSession('agent@offline-box', '/work/example')
    expect(writes).toEqual([])
    await store.createSession('codex@hal', '/work/dsh-plugin')
    expect(writes).toEqual([{ workerId: 'codex@hal', workspace: '/work/dsh-plugin' }])
    expect(store.snapshot().creation?.action?.['status']).toBe('succeeded')
    expect(store.snapshot().selected).toBe(store.snapshot().creation?.action?.['sessionId'])
    expect(store.snapshot().sessions.find(row => row['sessionId'] === store.snapshot().selected)?.['workspace']).toBe('/work/dsh-plugin')
  })

  it('does not duplicate accepted creation and retains failure without selecting another session', async () => {
    let creates = 0
    const store = new SessionStore(async operation => {
      if (operation === 'workers') return { workers: [{ id: 'w', status: 'online', capabilities: ['session-actions'] }] }
      if (operation === 'create_session') { creates++; return { actionId: 'a', status: 'accepted' } }
      if (operation === 'action') return { actionId: 'a', status: 'failed', error: { message: 'Directory unavailable' } }
      return { data: [], hasMore: false, nextCursor: null }
    })
    await store.loadWorkers()
    await Promise.all([store.createSession('w', '/work'), store.createSession('w', '/work')])
    await store.createSession('w', '/work')
    expect(creates).toBe(1)
    await store.checkCreation()
    expect(store.snapshot().creation?.notice).toContain('Directory unavailable')
    expect(store.snapshot().selected).toBeUndefined()
  })
})
