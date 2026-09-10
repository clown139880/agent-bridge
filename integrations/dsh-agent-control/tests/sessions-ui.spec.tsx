// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionStore } from '../src/client/session-store.js'
import { Sessions, UnifiedSessions } from '../src/client/sessions.js'
import { SessionTimeline } from '../src/client/session-timeline.js'
import { BridgeClient } from '../src/bridge-client.js'
import { SessionViewStore } from '../src/client/session-view-state.js'
import { SessionShortcuts } from '../src/client/session-shortcuts.js'
import { WorkspaceController } from '../src/client/index.js'
import { FooterAction } from '../src/client/index.js'
import { SessionComposer } from '../src/client/session-composer.js'

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  window.localStorage.clear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(node => node.textContent?.includes(text) || node.getAttribute('aria-label') === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}

describe('sessions with real DSH primitives', () => {
  it('creates a project conversation then submits by clicking the real DSH Button', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const writes: unknown[] = []
    const store = new SessionStore(async (operation, args) => {
      if (operation === 'submit_turn') writes.push(args)
      return client.call({ operation, ...(args ? { args } : {}) })
    }, async () => ({ default: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, routableProviders: ['anthropic', 'custom'], groups: [
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }] },
      { id: 'custom', name: 'Shared provider', models: [{ id: 'deepseek-v3.2', name: 'DeepSeek V3.2' }] },
    ], failures: [] }))
    await act(async () => root.render(createElement(Sessions, { store, refreshToken: 1 })))
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label^="New session in /work/dsh-plugin"]')!.click())
    const id = store.snapshot().selected!
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Model for next turn"]')!
    expect([...model.options].map(option => option.value)).toEqual(['claude-sonnet-4-5', 'deepseek-v3.2'])
    await act(async () => { model.value = 'deepseek-v3.2'; model.dispatchEvent(new Event('change', { bubbles: true })) })
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="Message to selected session"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Hello from the new project')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('Send').disabled).toBe(false)
    expect(button('Send').type).toBe('button')
    expect(host.querySelector('[data-external-conversation]')).not.toBeNull()
    expect(host.querySelector('[data-conversation-scroll][aria-label="Session history"]')).not.toBeNull()
    expect(host.querySelector('[data-external-composer]')).not.toBeNull()
    expect(host.querySelector('[data-external-composer] [aria-label="Model for next turn"]')).not.toBeNull()
    await act(async () => button('Send').click())
    expect(writes).toEqual([{ sessionId: id, input: 'Hello from the new project', delivery: 'auto', model: 'deepseek-v3.2' }])
    expect(store.snapshot().details[id]?.draft).toBe('')
    expect(host.querySelector('[aria-label="Session history"]')?.textContent).toContain('Hello from the new project')
  })

  it('uses Enter to submit but preserves Shift+Enter and IME confirmation', async () => {
    let sends = 0
    await act(async () => root.render(createElement(SessionComposer, { value: 'Draft', busy: false, canSend: true, active: false, attachments: [], onChange() {}, onSend() { sends++ }, onStop() {}, onAddImage() {}, onRemoveAttachment() {} })))
    const textarea = host.querySelector('textarea')!
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    expect(sends).toBe(0)
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(sends).toBe(1)
  })

  it('uses the native primary action to interrupt an active empty session', async () => {
    let stops = 0
    await act(async () => root.render(createElement(SessionComposer, { value: '', busy: false, canSend: true, active: true, attachments: [], onChange() {}, onSend() {}, onStop() { stops++ }, onAddImage() {}, onRemoveAttachment() {} })))
    expect(button('Stop').disabled).toBe(false)
    await act(async () => button('Stop').click())
    expect(stops).toBe(1)
  })

  it('exposes a direct Kanban navigation action alongside Bridge', async () => {
    const controller = new WorkspaceController(async () => ({ data: [], nextCursor: null, hasMore: false }))
    await act(async () => root.render(createElement(FooterAction as any, { controller, wide: true })))
    await act(async () => button('Kanban').click())
    expect(controller.snapshot()).toBe(true)
    expect(controller.panelSnapshot()).toBe('tasks')
    expect(host.querySelector('[aria-label="Session source"]')).toBeNull()
  })

  it('separates native and Bridge environments for the same path without id collisions and routes row clicks', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const store = new SessionStore((operation, args) => client.call({ operation, ...(args ? { args } : {}) }))
    const views = new SessionViewStore({ getItem: () => null, setItem: () => {} })
    const opened: string[] = []
    const nativeSnapshot = { ids: ['thr_active'], byId: { thr_active: { id: 'thr_active', displayTitle: 'Native twin', cwd: '/work/agent-bridge', running: true, blank: false, updatedAt: Date.now() } }, current: 'thr_active', phase: 'ready' }
    const workspaceSnapshot = { items: [{ workspaceId: 'workspace-a', path: '/work/agent-bridge', title: 'agent-bridge', sessionIds: ['thr_active'] }], archivedSessionIds: [], phase: 'ready' }
    // DSH controller observables use `this` internally. This matches the real
    // list service and guards against passing its methods bare to React.
    const nativeList = { refreshSnapshot: nativeSnapshot, getSnapshot() { return this.refreshSnapshot }, subscribe() { return () => {} } }
    const workspaceList = { refreshSnapshot: workspaceSnapshot, getSnapshot() { return this.refreshSnapshot }, subscribe() { return () => {} } }
    const nativeSessions = { list: nativeList, open: (id: string) => opened.push(`dsh:${id}`), create: async () => 'thr_active' }
    const nativeWorkspaces = { list: workspaceList }
    await act(async () => root.render(createElement(UnifiedSessions, { store, views, nativeSessions, nativeWorkspaces, bridgeSelected: false, openNative: (id: string) => opened.push(`dsh:${id}`), openBridge: (id: string) => opened.push(`bridge:${id}`) })))
    await vi.waitFor(() => expect(host.textContent).toContain('Bridge API'))
    expect(host.textContent).toContain('agent-bridge · local DSH')
    expect(host.textContent).toContain('agent-bridge · @hal')
    expect(host.textContent).toContain('Native twin · DSH')
    expect(host.textContent).toContain('Bridge API · Bridge')
    await act(async () => button('Native twin').click())
    await act(async () => button('Bridge API').click())
    expect(opened).toEqual(['dsh:thr_active', 'bridge:thr_active'])
    expect(host.querySelector('[aria-label="Pin Native twin"]')).toBeNull()
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search all conversations"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Native'); search.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(host.textContent).not.toContain('Bridge API · Bridge')
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('workspace').click())
    expect(views.snapshot().grouped).toBe(false)
  })

  it('persists pin/group choices and reuses the same store from the sidebar without preloading transcripts', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const controller = new WorkspaceController((operation, args) => client.call({ operation, ...(args ? { args } : {}) }))
    await act(async () => root.render(createElement(SessionShortcuts, { store: controller.sessions, views: controller.views, openSession: controller.openSession, wide: true })))
    await act(async () => button('Bridge sessions').click())
    expect(Object.keys(controller.sessions.snapshot().details)).toHaveLength(0)
    await act(async () => button('Release check').click())
    expect(controller.bridgeSnapshot()).toBe(true)
    expect(controller.snapshot()).toBe(false)
    expect(controller.sessionSnapshot()?.id).toBe('thr_approval')
    await act(async () => root.render(createElement(Sessions, { store: controller.sessions, views: controller.views, initialSessionId: controller.sessionSnapshot()?.id, refreshToken: 1 })))
    const pin = host.querySelector<HTMLButtonElement>('[aria-label="Pin Release check"]')!
    await act(async () => pin.click())
    expect(new SessionViewStore().snapshot().pinnedGroups).toEqual(['thr_approval'])
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Group sessions"]')!
    await act(async () => { select.value = 'flat'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(new SessionViewStore().snapshot().grouped).toBe(false)
    await act(async () => root.render(createElement(SessionShortcuts, { store: controller.sessions, views: controller.views, openSession: controller.openSession, wide: true })))
    await act(async () => button('Bridge sessions').click())
    expect(host.querySelector('strong')?.textContent).toBe('★ Release check')
  })

  it('shows terminal-only summaries as readable Markdown without duplicating a complete message', () => {
    const terminal = { eventId: 'terminal', sessionId: 'a', turnId: 'turn-1', type: 'turn.completed', timestamp: 1, payload: { summary: '## Readable summary\n\n**Result**' } }
    const summaryOnly = renderToStaticMarkup(createElement(SessionTimeline, { raw: false, events: [terminal] }))
    expect(summaryOnly).toContain('<h2>Readable summary</h2>')
    expect(summaryOnly).not.toContain('<details>')
    const complete = renderToStaticMarkup(createElement(SessionTimeline, { raw: false, events: [
      { eventId: 'message', sessionId: 'a', turnId: 'turn-1', type: 'message.completed', timestamp: 1, payload: { role: 'assistant', text: 'The answer' } }, terminal,
    ] }))
    expect(complete).toContain('<details>')
  })

  it('keeps structural turn markers out of the normal transcript', () => {
    const html = renderToStaticMarkup(createElement(SessionTimeline, { raw: false, events: [
      { eventId: 'start', sessionId: 'a', turnId: 'turn-1', type: 'turn.started', timestamp: 1, payload: {} },
      { eventId: 'finish', sessionId: 'a', turnId: 'turn-1', type: 'turn.completed', timestamp: 2, payload: {} },
      { eventId: 'message', sessionId: 'a', turnId: 'turn-1', type: 'message.completed', timestamp: 3, payload: { role: 'assistant', text: 'Visible answer' } },
    ] }))
    expect(html).toContain('Visible answer')
    expect(html).not.toContain('Turn started')
    expect(html).not.toContain('Turn completed')
  })

  it('renders grouped sessions, native Markdown and command output, then loads the second history page', async () => {
    const client = new BridgeClient({ mode: 'mock', origin: 'http://unused', tokenEnv: 'UNUSED', timeoutMs: 1000 })
    const store = new SessionStore((operation, args) => client.call({ operation, ...(args ? { args } : {}) }))
    await act(async () => root.render(createElement(Sessions, { store, refreshToken: 1 })))
    expect(host.textContent).toContain('Bridge API')
    expect(host.textContent).toContain('future.event')
    expect(host.querySelector('[data-external-chat-event="command"]')).not.toBeNull()
    expect(host.querySelector('[data-external-chat-event="file-change"]')).not.toBeNull()
    await act(async () => button('Load earlier messages').click())
    expect(host.querySelector('h3')?.textContent).toBe('验证结果')
    expect(host.querySelector('table')?.textContent).toContain('历史分页')
    const command = [...host.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent?.includes('pnpm test'))
    expect(command?.textContent).toContain('3 tests passed')
    expect(command?.open).toBe(false)
    expect(host.textContent).toContain('203 events')
    expect(host.querySelector('[aria-label="Context used"]')?.textContent).toBe('38%')
    expect(host.textContent).not.toContain('Offline fixture')
    await act(async () => button('Load more sessions').click())
    await act(async () => button('Show 1 more sessions').click())
    await act(async () => button('Offline fixture').click())
    expect(button('Send').disabled).toBe(true)
    expect(host.textContent).toContain('read-only')
    expect(host.querySelector('h3')).toBeNull()
  })

  it('keeps raw HTML and unsafe links inert using the actual Markdown renderer', () => {
    const html = renderToStaticMarkup(createElement(SessionTimeline, { raw: false, events: [{
      eventId: 'untrusted', sessionId: 'a', type: 'message.completed', timestamp: 1,
      payload: { role: 'assistant', text: '<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n**Safe text**' },
    }] }))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('<strong>Safe text</strong>')
  })
})
