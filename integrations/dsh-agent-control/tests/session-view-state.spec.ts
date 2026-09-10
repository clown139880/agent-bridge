import { describe, expect, it } from 'vitest'
import { SessionViewStore } from '../src/client/session-view-state.js'

describe('origin-local session preferences', () => {
  it('restores group, pin and reading anchor without serializing conversation content', () => {
    let saved = ''
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }
    const view = new SessionViewStore(storage)
    view.setGrouped(false); view.setAttention(true); view.toggleGroupPin('session-a'); view.setGroupsCollapsed(['workspace-a'], true)
    view.savePosition('session-a', { eventId: 'event-2', offset: -12 })
    expect(new SessionViewStore(storage).snapshot()).toEqual({ sort: 'updatedAt', grouped: false, attention: true, pinnedGroups: ['session-a'], collapsed: ['workspace-a'], activeOnly: [], positions: { 'session-a': { eventId: 'event-2', offset: -12 } } })
    expect(saved).not.toMatch(/draft|payload|text|token|origin/)
  })
  it('falls back to memory when storage is unavailable and bounds malformed saved data', () => {
    const view = new SessionViewStore({ getItem: () => '{broken', setItem: () => { throw new Error('quota exceeded') } })
    view.toggleGroupPin('a'); expect(view.snapshot().pinnedGroups).toEqual(['a'])
    const restored = new SessionViewStore({ getItem: () => JSON.stringify({ grouped: null, pinnedGroups: ['a', 'a', 42], positions: { a: { eventId: 'x', offset: 'wrong' } } }), setItem: () => {} })
    expect(restored.snapshot()).toMatchObject({ grouped: true, pinnedGroups: ['a'], positions: {} })
  })
  it('defaults project and session order to recent activity', () => {
    expect(new SessionViewStore({ getItem: () => null, setItem: () => {} }).snapshot().sort).toBe('updatedAt')
  })
})
