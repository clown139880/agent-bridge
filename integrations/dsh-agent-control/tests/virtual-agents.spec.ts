import { describe, expect, it, vi } from 'vitest'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { BridgeClient } from '../src/bridge-client.js'
import type { JsonValue } from '../src/types.js'
import { virtualSessionId } from '../src/remote-sessions/log.js'
import { VirtualBridgeAgents, virtualAgent, type WaitingSession } from '../src/remote-sessions/virtual-agents.js'

const ORIGIN = 'http://bridge.test'
const page = (data: unknown[]) => ({ data, hasMore: false }) as unknown as JsonValue

function host() {
  const store = new Map<string, unknown>()
  const detached: string[] = [], disposed: string[] = []
  let pending: { signal: AbortSignal; resolve(outcome: string): void } | undefined
  const ctx = {
    agents: {
      get: (id: string) => store.get(id),
      enter(agent: { id: string }) { store.set(agent.id, agent); return () => { store.delete(agent.id); detached.push(agent.id) } },
    },
    plugin: () => { const fiber = { ctx: {}, dispose: vi.fn(async () => { disposed.push('fiber') }) }; return fiber },
    approval: { request: vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<string>(resolve => {
      pending = { signal, resolve }
      signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
    })) },
    userQuestions: { ask: vi.fn(async () => ({ answers: [{ id: 'decision', selected: ['allow-session'] }] })) },
    logger: { warn: vi.fn() },
  }
  return { ctx, store, detached, disposed, answer: (outcome: string) => pending?.resolve(outcome), signal: () => pending?.signal }
}

describe('virtual Bridge session agents', () => {
  it('satisfies the native approval service with an open turn and an "ask" override', async () => {
    const service = Object.create(ApprovalService.prototype) as ApprovalService
    const waterfall = vi.fn(async () => 'allowed-once')
    Object.defineProperty(service, 'config', { value: { policy: 'never' } })
    Object.defineProperty(service, 'ctx', { value: { waterfall } })
    const agent = virtualAgent('bridge-remote-x', {} as never)
    expect(agent.id).toBe(agent.session.id)
    await expect(service.request({ agent, toolName: 'Bash', reason: 'ls' } as never)).resolves.toBe('allowed-once')
    expect(waterfall).toHaveBeenCalledOnce()
    expect((agent as unknown as { status: string }).status).toBe('idle')
    expect((agent.session as unknown as { requestContext(): unknown }).requestContext()).toBeUndefined()
  })

  it('enters an agent only while the session waits and withdraws it afterwards', async () => {
    const h = host()
    let rows: WaitingSession[] = [{ sessionId: 'old', status: 'idle' }, { sessionId: 'r1', status: 'waiting_for_approval' }]
    let approvalPending = true
    const call = vi.fn<BridgeClient['call']>(async request => {
      if (request.operation === 'approvals') return page(approvalPending ? [{ id: 'a1', sessionId: 'r1', status: 'pending', summary: 'run ls', choices: ['allow', 'deny'] }] : [])
      if (request.operation === 'approval') return { status: 'pending' } as JsonValue
      return page([])
    })
    const agents = new VirtualBridgeAgents(h.ctx as never, { call }, ORIGIN, () => rows)
    await agents.tick()
    const id = virtualSessionId(ORIGIN, 'r1')
    expect(agents.ids()).toEqual([id])
    expect(h.ctx.approval.request).toHaveBeenCalledOnce()
    expect(h.ctx.approval.request.mock.calls[0]![0]).toMatchObject({ agent: { id }, reason: 'run ls' })

    // Answered natively: decided on Bridge, the agent stays while Bridge still shows waiting.
    h.answer('allowed-once')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith({ operation: 'resolve_approval', args: { approvalId: 'a1', choice: 'allow' } }, expect.any(AbortSignal)))
    approvalPending = false
    rows = [{ sessionId: 'r1', status: 'active' }]
    await agents.tick()
    expect(agents.ids()).toEqual([])
    expect(h.detached).toEqual([id])
    expect(h.disposed).toEqual(['fiber'])
    expect(h.store.size).toBe(0)
    await agents.dispose()
  })

  it('withdraws a card handled elsewhere and asks other choices as a question', async () => {
    const h = host()
    const rows: WaitingSession[] = [{ sessionId: 'r1', status: 'waiting_for_approval' }]
    let row: unknown = { id: 'a1', sessionId: 'r1', status: 'pending', choices: ['allow', 'deny'] }
    const call = vi.fn<BridgeClient['call']>(async request => request.operation === 'approvals' ? page(row ? [row] : []) :
      request.operation === 'approval' ? { status: 'pending' } as JsonValue : page([]))
    const agents = new VirtualBridgeAgents(h.ctx as never, { call }, ORIGIN, () => rows)
    await agents.tick()
    const first = h.signal()!
    // Resolved in the Control Center: the native request is cancelled and nothing is decided here.
    row = { id: 'a2', sessionId: 'r1', status: 'pending', choices: ['allow', 'deny', 'allow-session'] }
    await agents.tick()
    expect(first.aborted).toBe(true)
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith({ operation: 'resolve_approval', args: { approvalId: 'a2', choice: 'allow-session' } }, expect.any(AbortSignal)))
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'resolve_approval', args: expect.objectContaining({ approvalId: 'a1' }) }), expect.anything())
    expect(h.ctx.userQuestions.ask).toHaveBeenCalledOnce()
    await agents.dispose()
    expect(agents.ids()).toEqual([])
    expect(h.store.size).toBe(0)
  })

  it('leaves an id it does not own alone', async () => {
    const h = host()
    const id = virtualSessionId(ORIGIN, 'r1')
    h.store.set(id, { id })
    const agents = new VirtualBridgeAgents(h.ctx as never, { call: vi.fn(async () => page([])) }, ORIGIN, () => [{ sessionId: 'r1', status: 'waiting_for_input' }])
    await agents.tick()
    expect(agents.ids()).toEqual([])
    expect(h.store.get(id)).toEqual({ id })
    await agents.dispose()
  })
})
