import type { BridgeStreamEvent, JsonObject, JsonValue } from '../types.js'
import type { BridgeRpc, BridgeStream } from './session-store.js'
import { asRecord } from './session-model.js'

/** The events a remote session's live activity is folded from. */
export const ACTIVITY_EVENT_TYPES = [
  'turn.started', 'turn.completed', 'turn.interrupted', 'turn.failed', 'progress',
  'tool.started', 'tool.completed', 'command.completed', 'file_change.completed',
  'task.started', 'task.progress', 'task.completed',
] as const
const TYPES: ReadonlySet<string> = new Set(ACTIVITY_EVENT_TYPES)
const COMPLETIONS = new Set(['tool.completed', 'command.completed', 'file_change.completed'])
const KEEP_EVENTS = 400
const KEEP_FINISHED = 10

export type PhaseKind = 'waiting' | 'thinking' | 'writing' | 'tool'
export interface ActivityPhase { kind: PhaseKind; label: string; since: number }
export interface ActivityTask {
  itemId: string
  kind: string
  description: string
  subagentType?: string
  background: boolean
  startedAt: number
  /** The count the task reports, or the steps seen here when it reports none. */
  toolUses: number
  lastToolName?: string
  progress?: string
  step?: string
  status?: string
  summary?: string
  endedAt?: number
}
export interface Activity {
  turn?: { id: string; startedAt: number }
  phase?: ActivityPhase
  tasks: ActivityTask[]
  finished: ActivityTask[]
  lastEventAt: number
}
export const IDLE_ACTIVITY: Activity = { tasks: [], finished: [], lastEventAt: 0 }

const str = (value: JsonValue | undefined, fallback = ''): string => typeof value === 'string' ? value : fallback
const time = (row: JsonObject) => typeof row['timestamp'] === 'number' ? row['timestamp'] : 0
const toolLabel = (row: JsonObject, payload: JsonObject) => row['type'] === 'command.completed' ? '$ ' + str(payload['command'])
  : str(payload['summary'], str(payload['name'], '工具'))

/**
 * What a remote session is doing now, from its recent activity events. The
 * Bridge reports only switches — a phase, a tool start, a task report — so how
 * long each has lasted is left to the clock of whoever shows it.
 */
export function foldActivity(events: readonly JsonObject[]): Activity {
  let turn: Activity['turn']
  let phase: ActivityPhase | undefined
  const tools = new Map<string, ActivityPhase>()
  const tasks = new Map<string, ActivityTask>()
  const stepsSeen = new Map<string, number>()
  const finished: ActivityTask[] = []
  let lastEventAt = 0
  const ordered = [...events].sort((a, b) => time(a) - time(b))
  for (const row of ordered) {
    const type = str(row['type'])
    const at = time(row)
    const payload = asRecord(row['payload'])
    const itemId = str(row['itemId'])
    const parent = str(payload['parentItemId'])
    lastEventAt = Math.max(lastEventAt, at)
    if (type === 'turn.started') {
      turn = { id: str(row['turnId']), startedAt: at }
      tools.clear()
      phase = { kind: 'waiting', label: '', since: at }
    } else if (type === 'turn.completed' || type === 'turn.interrupted' || type === 'turn.failed') {
      if (!turn || turn.id === str(row['turnId'])) { turn = undefined; phase = undefined; tools.clear() }
    } else if (type === 'progress') {
      const kind = payload['phase'] === 'writing' ? 'writing' : 'thinking'
      if (!tools.size) phase = { kind, label: str(payload['summary']), since: at }
    } else if (type === 'tool.started') {
      const task = parent ? tasks.get(parent) : undefined
      if (task) { task.step = toolLabel(row, payload); task.lastToolName = str(payload['name'], task.lastToolName) }
      else if (!parent && itemId) { phase = { kind: 'tool', label: toolLabel(row, payload), since: at }; tools.set(itemId, phase) }
    } else if (COMPLETIONS.has(type)) {
      const task = parent ? tasks.get(parent) : undefined
      if (task) { const seen = (stepsSeen.get(parent) ?? 0) + 1; stepsSeen.set(parent, seen); task.toolUses = Math.max(task.toolUses, seen) }
      else if (!parent && tools.delete(itemId)) phase = [...tools.values()].at(-1) ?? { kind: 'waiting', label: '', since: at }
    } else if (type === 'task.started' && itemId) {
      tasks.set(itemId, { itemId, kind: str(payload['kind'], 'other'), description: str(payload['description'], '后台任务'),
        ...(str(payload['subagentType']) ? { subagentType: str(payload['subagentType']) } : {}),
        background: payload['background'] === true, startedAt: at, toolUses: 0 })
    } else if (type === 'task.progress') {
      const task = tasks.get(itemId)
      if (task) {
        if (typeof payload['toolUses'] === 'number') task.toolUses = payload['toolUses']
        if (str(payload['lastToolName'])) task.lastToolName = str(payload['lastToolName'])
        if (str(payload['description'])) task.progress = str(payload['description'])
      }
    } else if (type === 'task.completed') {
      const task = tasks.get(itemId) ?? { itemId, kind: str(payload['kind'], 'other'), description: str(payload['description'], '后台任务'),
        ...(str(payload['subagentType']) ? { subagentType: str(payload['subagentType']) } : {}),
        background: false, startedAt: at - (Number(payload['durationMs']) || 0), toolUses: 0 }
      tasks.delete(itemId)
      if (typeof payload['toolUses'] === 'number') task.toolUses = payload['toolUses']
      finished.unshift({ ...task, status: str(payload['status'], 'completed'), summary: str(payload['summary']), endedAt: at })
    }
  }
  return { ...(turn ? { turn } : {}), ...(turn && phase ? { phase } : {}), tasks: [...tasks.values()], finished: finished.slice(0, KEEP_FINISHED), lastEventAt }
}

interface Watched { count: number; events: JsonObject[]; activity: Activity; loading: boolean }

/**
 * Live activity of the remote sessions on screen. One realtime stream serves
 * all of them; each session's recent events are read once when it is first
 * watched and again after every reconnect, so a gap never leaves a stale phase.
 */
export class ActivityStore {
  private readonly sessions = new Map<string, Watched>()
  private readonly listeners = new Set<() => void>()
  private abort: AbortController | undefined
  private live = false
  private poll: ReturnType<typeof setInterval> | undefined
  constructor(private readonly rpc: BridgeRpc, private readonly stream?: BridgeStream) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  activity(sessionId: string): Activity { return this.sessions.get(sessionId)?.activity ?? IDLE_ACTIVITY }

  watch(sessionId: string): () => void {
    let watched = this.sessions.get(sessionId)
    if (!watched) {
      watched = { count: 0, events: [], activity: IDLE_ACTIVITY, loading: false }
      this.sessions.set(sessionId, watched)
      void this.load(sessionId)
    }
    watched.count++
    this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.sessions.get(sessionId)
      if (current && --current.count <= 0) this.sessions.delete(sessionId)
      if (!this.sessions.size) this.stop()
    }
  }

  dispose(): void { this.sessions.clear(); this.stop() }

  private emit(): void { for (const listener of this.listeners) listener() }

  private merge(sessionId: string, rows: readonly JsonObject[]): void {
    const watched = this.sessions.get(sessionId)
    if (!watched) return
    const byId = new Map(watched.events.map(row => [str(row['eventId']), row]))
    let changed = false
    for (const row of rows) {
      const id = str(row['eventId'])
      if (!id || byId.has(id) || !TYPES.has(str(row['type']))) continue
      byId.set(id, row); changed = true
    }
    if (!changed) return
    watched.events = [...byId.values()].sort((a, b) => time(a) - time(b)).slice(-KEEP_EVENTS)
    watched.activity = foldActivity(watched.events)
    this.emit()
  }

  private async load(sessionId: string): Promise<void> {
    const watched = this.sessions.get(sessionId)
    if (!watched || watched.loading) return
    watched.loading = true
    try {
      const page = asRecord(await this.rpc('session_events', { sessionId, tail: true, limit: 200, type: [...ACTIVITY_EVENT_TYPES] } as unknown as JsonObject))
      const rows = (Array.isArray(page['data']) ? page['data'] : []).map(value => asRecord(value as JsonValue))
      this.merge(sessionId, rows.filter(row => row['sessionId'] === sessionId))
    } catch { /* The next reconnect or poll reads it again. */ }
    finally { watched.loading = false }
  }

  private reloadAll(): void { for (const id of this.sessions.keys()) void this.load(id) }

  private start(): void {
    this.poll ??= setInterval(() => { if (!this.live) this.reloadAll() }, 5_000)
    if (this.abort || !this.stream) return
    const abort = new AbortController()
    this.abort = abort
    void this.follow(abort.signal).finally(() => { if (this.abort === abort) this.abort = undefined })
  }

  private stop(): void {
    this.abort?.abort(); this.abort = undefined; this.live = false
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
  }

  private async follow(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted && this.stream) {
      try {
        // Starting from the current position; the reload on open covers what came before.
        for await (const message of this.stream(undefined, signal, () => { failures = 0; this.live = true; this.reloadAll() })) {
          if (signal.aborted) return
          this.apply(message)
        }
      } catch { /* Reconnect below. */ }
      this.live = false
      if (signal.aborted) return
      failures++
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(15_000, 1_000 * 2 ** Math.min(failures - 1, 4)))
        function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        signal.addEventListener('abort', done, { once: true })
      })
    }
  }

  private apply(message: BridgeStreamEvent): void {
    if (message.type !== 'session.event.appended') return
    const row = asRecord(message.data)
    const sessionId = str(row['sessionId'])
    if (this.sessions.has(sessionId)) this.merge(sessionId, [row])
  }
}
