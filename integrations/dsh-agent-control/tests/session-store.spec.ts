import { describe, expect, it, vi } from 'vitest'
import type { JsonObject, JsonValue } from '../src/types.js'
import { SessionStore, type BridgeRpc } from '../src/client/session-store.js'
import { groupSessions, latestSessionModel, projectEvents, sessionTitle } from '../src/client/session-model.js'
import { BridgeClient } from '../src/bridge-client.js'

const page = (data: JsonObject[] = [], cursor: string | null = null, hasMore = false): JsonValue => ({ data, nextCursor: cursor, hasMore })
const session = (id: string, turn = 'turn-1'): JsonObject => ({ sessionId: id, title: id, workspace: '/repo', workerId: 'w', status: 'active', activeTurnId: turn, updatedAt: 1, capabilities: ['session-actions'] })
const event = (id: string, sessionId = 'a'): JsonObject => ({ eventId: id, sessionId, type: 'message.completed', turnId: 'turn-1', itemId: id, timestamp: 1, payload: { role: 'assistant', text: id } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const baseRpc: BridgeRpc = async (operation, args = {}) => operation === 'session' ? session(String(args['sessionId'])) : page()

describe('SessionStore', () => {
  it('loads every session from today, then pages older history on demand', async () => {
    const now = Date.now()
    const first = Array.from({ length: 200 }, (_, index) => ({ ...session(`s${index}`), updatedAt: now }))
    const second = Array.from({ length: 25 }, (_, index) => ({ ...session(`s${index + 200}`), updatedAt: now }))
    const old = { ...session('old'), status: 'idle', updatedAt: 1 }
    const rpc = vi.fn<BridgeRpc>(async (operation, args) => {
      if (operation !== 'sessions') return baseRpc(operation, args)
      if (args?.['segment'] === 'history') return page([old])
      return args?.['cursor'] ? page(second) : page(first, 'opaque:/today-next', true)
    })
    const store = new SessionStore(rpc)
    await store.loadSessions(); expect(store.snapshot().sessions).toHaveLength(225); expect(store.snapshot().hasMore).toBe(true)
    await store.loadSessions(true); expect(store.snapshot().sessions).toHaveLength(226); expect(store.snapshot().hasMore).toBe(false)
    await store.loadSessions(); expect(store.snapshot().sessions).toHaveLength(226)
    expect(rpc).toHaveBeenCalledWith('sessions', expect.objectContaining({ segment: 'recent', limit: 200, cursor: 'opaque:/today-next' }))
    expect(rpc).toHaveBeenCalledWith('sessions', expect.objectContaining({ segment: 'history', limit: 200 }))
  })

  it('retains per-session drafts and never publishes delayed A events under selected B', async () => {
    const delayed = deferred<JsonValue>()
    const store = new SessionStore(async (op, args) => op === 'session_events' ? args?.['sessionId'] === 'a' ? delayed.promise : page([event('b1', 'b')]) : baseRpc(op, args))
    store.select('a'); store.setDraft('a', 'draft A')
    store.setModel('a', 'model-a')
    store.select('b'); store.setDraft('b', 'draft B'); store.setModel('b', 'model-b')
    await vi.waitFor(() => expect(store.snapshot().details['b']?.loaded).toBe(true))
    delayed.resolve(page([event('a1')]))
    await vi.waitFor(() => expect(store.snapshot().details['a']?.loaded).toBe(true))
    expect(store.snapshot().selected).toBe('b')
    expect(store.snapshot().details['b']?.events[0]?.['eventId']).toBe('b1')
    expect(store.snapshot().details['a']?.draft).toBe('draft A')
    expect(store.snapshot().details['b']?.draft).toBe('draft B')
    expect(store.snapshot().details['a']?.model).toBe('model-a')
    expect(store.snapshot().details['b']?.model).toBe('model-b')
  })

  it('deletes one session, drops its cached detail and selects the neighboring session', async () => {
    const rpc = vi.fn<BridgeRpc>(async (operation, args) => operation === 'delete_session'
      ? { sessionId: args?.['sessionId'] ?? null, actionId: 'delete-a', kind: 'delete_session', status: 'succeeded' }
      : operation === 'sessions' ? page([session('a'), session('b')]) : baseRpc(operation, args))
    const store = new SessionStore(rpc)
    await store.loadSessions(); store.select('a')
    await vi.waitFor(() => expect(store.snapshot().details['a']?.session).toBeTruthy())
    expect(await store.deleteSession('a')).toBe(true)
    expect(store.snapshot().sessions.map(row => row['sessionId'])).toEqual(['b'])
    expect(store.snapshot().details['a']).toBeUndefined()
    expect(store.snapshot().selected).toBe('b')
    expect(rpc).toHaveBeenCalledWith('delete_session', { sessionId: 'a' })
  })

  it('applies a model only to a new turn and omits it while steering', async () => {
    let active = false
    const rpc = vi.fn<BridgeRpc>(async (op, args) => {
      if (op === 'session') return { ...session('a', active ? 'turn-live' : ''), status: active ? 'active' : 'idle', activeTurnId: active ? 'turn-live' : null }
      if (op === 'submit_turn') return { actionId: active ? 'steer' : 'new-turn', status: 'succeeded' }
      return baseRpc(op, args)
    })
    const store = new SessionStore(rpc)
    await store.refreshDetail('a'); store.setDraft('a', 'first'); store.setModel('a', 'gpt-5.6-sol')
    await store.act('a', 'submit_turn')
    expect(rpc).toHaveBeenCalledWith('submit_turn', { sessionId: 'a', input: 'first', delivery: 'auto', model: 'gpt-5.6-sol' })
    active = true; await store.refreshDetail('a'); store.setDraft('a', 'steer')
    await store.act('a', 'submit_turn')
    expect(rpc).toHaveBeenCalledWith('submit_turn', { sessionId: 'a', input: 'steer', delivery: 'auto', expectedTurnId: 'turn-live' })
  })

  it('reads the latest refreshed turn for a mutation, tracks accepted failure and preserves draft', async () => {
    let turn = 'old'
    const rpc = vi.fn<BridgeRpc>(async (op, args) => {
      if (op === 'session') return session('a', turn)
      if (op === 'submit_turn') return { actionId: 'action-1', status: 'accepted' }
      if (op === 'action') return { actionId: 'action-1', status: 'failed', error: { message: 'Turn changed' } }
      return baseRpc(op, args)
    })
    const store = new SessionStore(rpc)
    await store.refreshDetail('a'); turn = 'new'; await store.refreshDetail('a')
    store.setDraft('a', 'continue')
    await store.act('a', 'submit_turn')
    expect(rpc).toHaveBeenCalledWith('submit_turn', { sessionId: 'a', input: 'continue', delivery: 'auto', expectedTurnId: 'new' })
    await store.act('a', 'submit_turn')
    expect(rpc.mock.calls.filter(([op]) => op === 'submit_turn')).toHaveLength(1)
    await store.checkAction('a')
    expect(store.snapshot().details['a']?.notice).toContain('Turn changed')
    expect(store.snapshot().details['a']?.draft).toBe('continue')
  })

  it('settles only the submitted session draft and rejects concurrent writes', async () => {
    const receipt = deferred<JsonValue>()
    const rpc = vi.fn<BridgeRpc>(async (op, args) => op === 'submit_turn' ? receipt.promise : baseRpc(op, args))
    const store = new SessionStore(rpc)
    await store.refreshDetail('a'); store.setDraft('a', 'send A')
    const writing = store.act('a', 'submit_turn')
    await store.act('a', 'submit_turn')
    store.select('b'); store.setDraft('b', 'keep B')
    receipt.resolve({ actionId: 'a1', status: 'succeeded' }); await writing
    expect(store.snapshot().details['a']?.draft).toBe('')
    expect(store.snapshot().details['b']?.draft).toBe('keep B')
    expect(rpc.mock.calls.filter(([op]) => op === 'submit_turn')).toHaveLength(1)
  })

  it('keeps retained history after cursor expiry and supports explicit baseline reload', async () => {
    const rpc = vi.fn<BridgeRpc>(async (op, args) => {
      if (op !== 'session_events') return baseRpc(op, args)
      if (args?.['before']) throw new Error('cursor_expired')
      return page([event('1')], 'opaque-event-cursor')
    })
    const store = new SessionStore(rpc)
    await store.loadEvents('a'); await store.loadEvents('a')
    expect(store.snapshot().details['a']?.events).toHaveLength(1)
    expect(store.snapshot().details['a']?.eventsError).toBe('cursor_expired')
    await store.loadEvents('a', true)
    expect(store.snapshot().details['a']?.eventsError).toBe('')
  })

  it('deduplicates event pages and diagnoses a stuck continuation', async () => {
    let reads = 0
    const store = new SessionStore(async () => ++reads === 1 ? page([event('1')], 'x', true) : reads === 2 ? page([event('1'), event('2')], 'y', true) : page([event('3')], 'y', true))
    await store.loadEvents('a'); await store.loadEvents('a'); await store.loadEvents('a')
    expect(store.snapshot().details['a']?.events).toHaveLength(2)
    expect(store.snapshot().details['a']?.eventsError).toContain('did not advance')
  })

  it('ignores a pending read after disposal and can reactivate for a new mount', async () => {
    const delayed = deferred<JsonValue>()
    let read = 0
    const store = new SessionStore(async (op, args) => op === 'sessions' ? ++read === 1 ? delayed.promise : page([session('new')]) : baseRpc(op, args))
    const stale = store.loadSessions(); store.dispose(); store.activate()
    await store.loadSessions(); delayed.resolve(page([session('old')])); await stale
    expect(store.snapshot().sessions[0]?.['sessionId']).toBe('new')
  })

  it('retains an in-flight write receipt across closing and reopening the workspace', async () => {
    const receipt = deferred<JsonValue>()
    const rpc = vi.fn<BridgeRpc>(async (op, args) => op === 'submit_turn' ? receipt.promise : baseRpc(op, args))
    const store = new SessionStore(rpc)
    await store.refreshDetail('a'); store.setDraft('a', 'keep until confirmed')
    const writing = store.act('a', 'submit_turn')
    store.dispose(); store.activate()
    await store.act('a', 'submit_turn')
    expect(rpc.mock.calls.filter(([op]) => op === 'submit_turn')).toHaveLength(1)
    receipt.resolve({ actionId: 'pending-on-close', status: 'accepted' }); await writing
    expect(store.snapshot().details['a']?.action?.['actionId']).toBe('pending-on-close')
    expect(store.snapshot().details['a']?.draft).toBe('keep until confirmed')
  })

  it('loads all pending pages and rejects cross-session history', async () => {
    const store = new SessionStore(async (op, args) => {
      if (op === 'approvals') return args?.['cursor'] ? page([{ id: 'two', sessionId: 'a', status: 'pending' }]) : page([{ id: 'one', sessionId: 'a', status: 'pending' }], 'pending-next', true)
      if (op === 'session_events') return page([event('wrong', 'b')])
      return baseRpc(op, args)
    })
    await store.refreshDetail('a'); await store.loadEvents('a')
    expect(store.snapshot().details['a']?.approvals).toHaveLength(2)
    expect(store.snapshot().details['a']?.events).toHaveLength(0)
    expect(store.snapshot().details['a']?.eventsError).toContain('different session')
  })

  it('reads more than 200 real mock envelopes with the same client as production', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const store = new SessionStore((operation, args) => client.call({ operation, ...(args ? { args } : {}) }))
    await store.loadSessions(); store.select('thr_active'); await store.refreshDetail('thr_active')
    await vi.waitFor(() => expect(store.snapshot().details['thr_active']?.loaded).toBe(true))
    expect(store.snapshot().details['thr_active']?.hasMore).toBe(true)
    await store.loadEvents('thr_active')
    expect(store.snapshot().details['thr_active']?.events).toHaveLength(203)
    expect(store.snapshot().details['thr_active']?.hasMore).toBe(false)
  })

  it('uses the native DSH provider catalog and preserves third-party model ids', async () => {
    const nativeCatalog = { default: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, routableProviders: ['anthropic', 'openai-compatible'], groups: [
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }] },
      { id: 'openai-compatible', name: 'Custom', models: [{ id: 'deepseek-v3.2', name: 'DeepSeek V3.2' }] },
    ], failures: [] }
    const loader = vi.fn(async () => nativeCatalog)
    const store = new SessionStore(baseRpc, loader)
    await store.loadModels('codex@hal')
    expect(loader).toHaveBeenCalledOnce()
    expect(store.snapshot().modelCatalogs['codex@hal']?.catalog).toEqual(nativeCatalog)
    store.setModel('a', 'deepseek-v3.2')
    await store.refreshDetail('a'); store.setDraft('a', 'use custom model'); await store.act('a', 'submit_turn')
    expect(store.snapshot().details['a']?.model).toBe('deepseek-v3.2')
  })

  it('does not fall back to the Codex model inventory when the DSH catalog is unavailable', async () => {
    const rpc = vi.fn(baseRpc)
    const store = new SessionStore(rpc)
    await store.loadModels('codex@hal')
    expect(rpc.mock.calls.some(([operation]) => operation === 'models')).toBe(false)
    expect(store.snapshot().modelCatalogs['codex@hal']?.error).toContain('DSH provider model catalog')
  })
})

describe('session presentation projection', () => {
  it('derives the selected model from the latest retained turn', () => {
    expect(latestSessionModel([
      { eventId: 'a', payload: { model: 'gpt-5.6-sol' } },
      { eventId: 'b', payload: { model: 'gpt-5.6-terra' } },
    ])).toBe('gpt-5.6-terra')
    expect(latestSessionModel([{ eventId: 'c', type: 'model.rerouted', payload: { toModel: 'kimi-k3' } }])).toBe('kimi-k3')
  })
  it('uses the first prompt summary before falling back to a project and id', () => {
    expect(sessionTitle({ sessionId: 'abcdefghi', projectName: 'repo', promptSummary: '  Fix   the flaky test  ' })).toBe('Fix the flaky test')
    expect(sessionTitle({ sessionId: 'abcdefghi', projectName: 'repo' })).toBe('repo · abcdefgh')
  })
  it('merges a hydrated item without dropping equal text from different items', () => {
    const source = event('one')
    expect(projectEvents([source, { ...source, eventId: 'live-copy' }, event('two')]).map(row => row['eventId'])).toEqual(['live-copy', 'two'])
  })
  it('separates identical paths on different workers and filters only loaded metadata', () => {
    const groups = groupSessions([session('a'), { ...session('b'), workerId: 'other', status: 'waiting_for_input' }], '/repo', true, false)
    expect(groups).toHaveLength(2)
    expect(groupSessions(groups.flatMap(group => group.sessions), '', false, true)[0]?.sessions.map(row => row['sessionId'])).toEqual(['b'])
  })
})
