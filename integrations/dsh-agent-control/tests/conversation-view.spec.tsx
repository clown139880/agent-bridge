// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectEntry, type EntryView } from '@agent-bridge/transcript'
import { SessionStore } from '../src/client/session-store.js'
import { ConversationPanel } from '../src/client/conversation-view.js'
import type { BridgeStreamEvent, JsonObject, JsonValue } from '../src/types.js'

let container: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

const entry = (id: string, anchor: number, rev: number, events: Array<[string, Record<string, unknown>, string?]>): EntryView => ({
  ...projectEntry({ key: `t:${id}`, superseded: false, events: events.map(([type, payload, item], i) => ({ seq: anchor + i, eventId: `${id}-${i}`,
    cursor: `e:${anchor + i}`, sessionId: 's', type, turnId: id, itemId: item ?? null, timestamp: anchor + i, payload })) }), rev })

describe('Bridge conversation view in DSH', () => {
  it('renders the served view, follows view revisions from the stream and never reads native history', async () => {
    let revision = 1, entries = [entry('t1', 1, 1, [['message.completed', { role: 'user', text: '你好' }], ['command.completed', { command: 'ls', exitCode: 0 }, 'c'],
      ['message.completed', { role: 'assistant', text: '完成了' }], ['turn.completed', {}]])]
    const rpc = vi.fn(async (operation: string, args: JsonObject = {}): Promise<JsonValue> => {
      if (operation === 'session') return { sessionId: 's', title: '远端会话', status: 'idle', activeTurnId: null, capabilities: ['session-actions'] }
      if (operation === 'session_view') return { projectionVersion: 1, viewRevision: revision, orderingEpoch: 0, rawHigh: revision, entries, entriesBefore: null, streamCursor: 'c:0:0' } as never
      if (operation === 'session_view_changes') return { projectionVersion: 1, fromRevision: args['since'], toRevision: revision, hasMore: false, orderingEpoch: 0,
        entries: entries.filter(e => e.rev > Number(args['since'])), removed: [], raw: { after: args['rawAfter'], through: revision, count: revision - Number(args['rawAfter']) }, streamCursor: 'c:0:0' } as never
      if (operation === 'snapshot') return { workers: [], sessions: [], approvals: [], userInput: [], streamCursor: 'c:0:0' }
      return { data: [], hasMore: false, nextCursor: null }
    })
    let push!: (event: BridgeStreamEvent) => void
    async function* stream(): AsyncIterable<BridgeStreamEvent> {
      while (true) yield await new Promise<BridgeStreamEvent>(resolve => { push = resolve })
    }
    const store = new SessionStore(rpc as never, undefined, stream)
    await act(async () => root.render(createElement(ConversationPanel, { store, sessionId: 's', onClose: () => {} })))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(container.textContent).toContain('你好'); expect(container.textContent).toContain('完成了')
    expect(container.textContent).toContain('已完成'); expect(container.textContent).toContain('$ ls')

    // An external client reports idle and keeps writing to the same turn.
    revision = 2
    entries = [entry('t1', 1, 2, [['message.completed', { role: 'user', text: '你好' }], ['turn.completed', {}], ['message.completed', { role: 'assistant', text: '又补充一句' }]])]
    await act(async () => { push({ cursor: 'c:1:1', eventId: 'change:1', type: 'session.updated', sessionId: 's', resource: { kind: 'session', id: 's' },
      timestamp: 2, data: { sessionId: 's', status: 'idle', viewRevision: 2 } }); await new Promise(r => setTimeout(r, 20)) })
    expect(container.textContent).toContain('又补充一句'); expect(container.textContent).toContain('之后仍有活动')
    expect(rpc.mock.calls.map(c => c[0])).toContain('session_view_changes')
    expect(rpc.mock.calls.some(c => c[0] === 'import')).toBe(false)
    store.dispose()
  })
})
