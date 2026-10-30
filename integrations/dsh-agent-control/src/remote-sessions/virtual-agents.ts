import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BridgeClient } from '../bridge-client.js'
import { relayPendingInteractions } from '../agent-bridge-provider/approval-bridge.js'
import { virtualSessionId } from './log.js'

/** Bridge statuses during which the session may have a pending approval or question. */
export const WAITING_STATUSES: ReadonlySet<string> = new Set(['waiting_for_approval', 'waiting_for_input'])
const POLL_MS = 2500

export interface WaitingSession { sessionId: string; status: string }
interface AgentRegistryFace { enter(agent: Agent, owner: Agent | undefined): () => void; get(id: string): Agent | undefined }
type Services = Context & { agents: AgentRegistryFace; logger: { warn(message: string): void } }
interface Entry { remoteId: string; agent: Agent; detach: () => void; fiber: { dispose(): unknown }; abort: AbortController; jobs: Map<string, Promise<void>>; failed: string }

/**
 * A stand-in agent for one virtual Bridge session. It only carries the identity
 * and an in-memory turn that `approval.request` and `userQuestions.ask` need to
 * route a request to the native cards of the session's scope; it never runs a
 * model and never persists. The values read by Host code that walks
 * `agents.list()` are given safe defaults: idle, no provider, no lineage.
 */
export function virtualAgent(id: string, ctx: Context): Agent {
  // The approval audit pair must be turn-enclosed; the policy override keeps a
  // Desktop-wide "never" from silently denying another machine's request.
  const events: { seq: number; type: string; data: unknown }[] = [
    { seq: 0, type: 'turn/start', data: {} },
    { seq: 1, type: 'approval/policy', data: { policy: 'ask' } },
  ]
  const session = {
    id, header: {},
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
    append(type: string, data: unknown) { const event = { seq: events.length, type, data }; events.push(event); return event },
    requestContext: () => undefined,
  }
  return { id, ctx, session, status: 'idle', options: {}, inbox: { nextTurn: [], nextStep: [] } } as unknown as Agent
}

/**
 * Enters a virtual Bridge session's stand-in agent only while the Bridge
 * session waits for approval or input, and relays its pending items through
 * the native approval and question cards. Answering, cancelling, resolving
 * elsewhere, or the session leaving the waiting state withdraws the cards and
 * the agent, as native sessions only have agents while loaded.
 */
export class VirtualBridgeAgents {
  private readonly entries = new Map<string, Entry>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> | undefined
  private disposed = false

  constructor(private readonly ctx: Services, private readonly bridge: Pick<BridgeClient, 'call'>, private readonly origin: string,
    private readonly waiting: () => readonly WaitingSession[]) {}

  start(): void {
    this.timer ??= setInterval(() => { void this.tick() }, POLL_MS)
    this.timer.unref?.()
  }

  /** Ids of the agents currently entered, for diagnostics and tests. */
  ids(): string[] { return [...this.entries.keys()] }

  tick(): Promise<void> {
    return this.ticking ??= this.reconcile().finally(() => { this.ticking = undefined })
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return
    const wanted = new Map<string, string>()
    for (const row of this.waiting()) if (row.sessionId && WAITING_STATUSES.has(row.status)) wanted.set(virtualSessionId(this.origin, row.sessionId), row.sessionId)
    await Promise.all([...this.entries].filter(([id]) => !wanted.has(id)).map(([id]) => this.retire(id)))
    await Promise.all([...wanted].map(async ([id, remoteId]) => {
      const entry = this.entries.get(id) ?? this.enter(id, remoteId)
      if (!entry) return
      try {
        await relayPendingInteractions(this.bridge, entry.agent, remoteId, entry.jobs, entry.abort.signal, this.ctx as never, true)
        entry.failed = ''
      } catch (error) {
        // A transient Bridge failure is retried next tick; report each new failure once.
        if (!entry.abort.signal.aborted && entry.failed !== String(error)) {
          entry.failed = String(error)
          this.ctx.logger.warn('Bridge interaction relay ' + remoteId + ': ' + entry.failed)
        }
      }
    }))
  }

  private enter(id: string, remoteId: string): Entry | undefined {
    if (this.ctx.agents.get(id)) return undefined
    const fiber = this.ctx.plugin(() => {})
    const agent = virtualAgent(id, fiber.ctx)
    let detach: () => void
    try { detach = this.ctx.agents.enter(agent, undefined) } catch (error) {
      void fiber.dispose()
      this.ctx.logger.warn('Bridge interaction agent ' + remoteId + ': ' + String(error))
      return undefined
    }
    const entry: Entry = { remoteId, agent, detach, fiber, abort: new AbortController(), jobs: new Map(), failed: '' }
    this.entries.set(id, entry)
    return entry
  }

  private async retire(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.abort.abort()
    await Promise.allSettled(entry.jobs.values())
    entry.detach()
    await entry.fiber.dispose()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    await Promise.all([...this.entries.keys()].map(id => this.retire(id)))
  }
}
