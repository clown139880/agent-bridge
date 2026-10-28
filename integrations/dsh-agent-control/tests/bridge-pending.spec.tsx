// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgePending, BridgePendingPanel, installBridgePending } from '../src/client/bridge-pending.js'
import type { NativeEntry } from '../src/client/native-catalog.js'

let container: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const entry = (status: string) => ({ nativeId: 'bridge-remote-x', sessionId: 'remote-x', status }) as NativeEntry

describe('Bridge approvals and questions in the native composer', () => {
  it('publishes the waiting approval, answers it through Bridge and retracts it', async () => {
    let rows = [entry('waiting_for_approval')], notify!: () => void
    let pending: Array<Record<string, unknown>> = [{ id: 'ap1', status: 'pending', summary: '$ rm -rf build', choices: ['allow', 'deny'] }]
    const rpc = vi.fn(async (operation: string, _args?: Record<string, unknown>) => {
      if (operation === 'approvals') return { data: pending }
      if (operation === 'user_input') return { data: [] }
      pending = []; return { status: 'succeeded' }
    })
    const removed = vi.fn(), published: BridgePending[] = []
    const publish = vi.fn((interaction: BridgePending) => { published.push(interaction); return removed })
    const stop = installBridgePending(publish, rpc, { snapshot: () => rows, subscribe: listener => { notify = listener; return () => {} } })
    await flush()
    expect(rpc).toHaveBeenCalledWith('approvals', { sessionId: 'remote-x', status: 'pending', limit: 20 })
    expect(published).toHaveLength(1); expect(published[0]).toMatchObject({ key: 'ap1', kind: 'bridge-approval', sessionId: 'bridge-remote-x' })
    await act(async () => root.render(createElement(BridgePendingPanel, { matched: published[0]! })))
    expect(container.textContent).toContain('rm -rf build')
    await act(async () => { (container.querySelector('button') as HTMLButtonElement).click() })
    await flush()
    expect(rpc).toHaveBeenCalledWith('resolve_approval', { approvalId: 'ap1', choice: 'allow' })
    expect(removed).toHaveBeenCalled()
    rows = [entry('idle')]; notify(); stop()
  })
  it('answers a question with the Bridge answer shape', async () => {
    const rpc = vi.fn(async (operation: string, _args?: Record<string, unknown>) => operation === 'user_input'
      ? { data: [{ id: 'q1', status: 'pending', questions: [{ id: 'a', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }] }] }
      : operation === 'approvals' ? { data: [] } : { status: 'succeeded' })
    const published: BridgePending[] = []
    const stop = installBridgePending(interaction => { published.push(interaction); return () => {} }, rpc, { snapshot: () => [entry('waiting_for_input')], subscribe: () => () => {} })
    await flush()
    expect(published[0]!.kind).toBe('bridge-question')
    await act(async () => root.render(createElement(BridgePendingPanel, { matched: published[0]! })))
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === '是')!.click() })
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit() })
    expect(rpc).toHaveBeenCalledWith('respond_user_input', { requestId: 'q1', answers: { a: { answers: ['是'] } } })
    stop()
  })
})
