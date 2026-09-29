import { describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../src/types.js'
import { ActivityStore, foldActivity } from '../src/client/activity.js'
import { elapsed, phaseLine, STALL_MS, taskDetail, taskTitle } from '../src/client/activity-dock.js'

let seq = 0
const event = (type: string, timestamp: number, payload: JsonObject = {}, itemId = ''): JsonObject => ({
  eventId: `e${++seq}`, sessionId: 's', turnId: 't1', itemId, timestamp, type, payload,
})

describe('remote activity fold', () => {
  it('follows a turn through thinking, a tool and writing, and ends with it', () => {
    const start = [event('turn.started', 1000), event('progress', 1500, { phase: 'thinking' })]
    expect(foldActivity(start)).toMatchObject({ turn: { id: 't1', startedAt: 1000 }, phase: { kind: 'thinking', since: 1500 } })
    const tool = [...start, event('tool.started', 2000, { name: 'Bash', summary: '$ pnpm test' }, 'b1')]
    expect(foldActivity(tool).phase).toEqual({ kind: 'tool', label: '$ pnpm test', since: 2000 })
    // A phase report while a tool runs does not hide that tool.
    expect(foldActivity([...tool, event('progress', 2100, { phase: 'thinking' })]).phase?.kind).toBe('tool')
    const back = [...tool, event('command.completed', 5000, { command: 'pnpm test' }, 'b1')]
    expect(foldActivity(back).phase).toEqual({ kind: 'waiting', label: '', since: 5000 })
    const writing = [...back, event('progress', 6000, { phase: 'writing' })]
    expect(foldActivity(writing).phase?.kind).toBe('writing')
    const ended = foldActivity([...writing, event('turn.completed', 7000, { status: 'completed' })])
    expect(ended.turn).toBeUndefined()
    expect(ended.phase).toBeUndefined()
    expect(ended.lastEventAt).toBe(7000)
  })

  it('tracks subagents and background tasks past the end of the turn', () => {
    const events = [
      event('turn.started', 0),
      event('task.started', 100, { kind: 'agent', subagentType: 'Explore', description: 'Map the repo', background: false }, 'spawn'),
      event('task.started', 200, { kind: 'bash', description: 'sleep 120', background: true }, 'bg'),
      event('tool.started', 300, { name: 'Grep', summary: 'Grep "foo"', parentItemId: 'spawn' }, 'g1'),
      event('tool.completed', 400, { name: 'Grep', summary: 'Grep "foo"', parentItemId: 'spawn' }, 'g1'),
      event('tool.started', 500, { name: 'Read', summary: 'Read a.ts', parentItemId: 'spawn' }, 'r1'),
      event('task.progress', 600, { toolUses: 4, lastToolName: 'Read', description: 'Reading a.ts' }, 'spawn'),
      event('task.completed', 900, { kind: 'agent', subagentType: 'Explore', description: 'Map the repo', status: 'completed', summary: 'Two modules' }, 'spawn'),
      event('turn.completed', 1000, { status: 'completed' }),
    ]
    const before = foldActivity(events.slice(0, 7))
    // Subagent steps never become the main phase.
    expect(before.phase).toEqual({ kind: 'waiting', label: '', since: 0 })
    expect(before.tasks.map(task => [task.itemId, task.toolUses, task.step, task.progress])).toEqual([
      ['spawn', 4, 'Read a.ts', 'Reading a.ts'], ['bg', 0, undefined, undefined],
    ])
    const after = foldActivity(events)
    expect(after.turn).toBeUndefined()
    expect(after.tasks.map(task => task.itemId)).toEqual(['bg'])
    expect(after.finished).toMatchObject([{ itemId: 'spawn', status: 'completed', summary: 'Two modules', startedAt: 100, endedAt: 900 }])
  })

  it('shows a task that ended without its start in view', () => {
    const fold = foldActivity([event('task.completed', 10_000, { kind: 'monitor', description: 'watch logs', status: 'lost', durationMs: 4000 }, 'm')])
    expect(fold.finished).toMatchObject([{ kind: 'monitor', status: 'lost', startedAt: 6000 }])
  })
})

describe('activity dock wording', () => {
  const running = foldActivity([event('turn.started', 0), event('progress', 1000, { phase: 'thinking' })])
  it('counts the current phase up and flags a silent turn', () => {
    expect(phaseLine(running, 43_000, 'active', true)).toEqual({ tone: 'normal', text: '🧠 思考中 · 42s' })
    expect(phaseLine(running, 1000 + STALL_MS + 60_000, 'active', true)).toEqual({ tone: 'warn', text: '🧠 思考中 · 2m30s · 2 分钟无新输出' })
    expect(phaseLine(running, 5000, 'active', false)?.text).toBe('🧠 思考中 · 4s · 执行端离线')
    expect(phaseLine(running, 5000, 'waiting_for_approval', true)?.text).toBe('🧠 思考中 · 4s · 等待你的审批')
    const tool = foldActivity([event('turn.started', 0), event('tool.started', 0, { name: 'Bash', summary: '$ pnpm test' }, 'b')])
    expect(phaseLine(tool, 72_000, 'active', true)?.text).toBe('💻 pnpm test · 1m12s')
    expect(phaseLine(foldActivity([]), 0, 'idle', true)).toBeUndefined()
  })
  it('says only that an older Bridge runs, with its latest step, instead of claiming it waits', () => {
    const old = foldActivity([event('turn.started', 0),
      event('command.completed', 300_000, { command: 'pnpm test' }, 'b'),
      event('file_change.completed', 320_000, { changes: [{ path: 'src/a.ts' }] }, 'f')])
    expect(old.phased).toBe(false)
    expect(phaseLine(old, 339_000, 'active', true)).toEqual({ tone: 'normal', text: '⏳ 运行中 · 5m39s · 上一步：修改 src/a.ts · 19s前' })
    expect(phaseLine(foldActivity([event('turn.started', 0)]), 5000, 'active', true)?.text).toBe('⏳ 运行中 · 5s')
  })
  it('leaves the thinking clock to DSH while it streams the turn itself', () => {
    expect(phaseLine(running, 43_000, 'active', true, true)).toBeUndefined()
    expect(phaseLine(running, 1000 + STALL_MS, 'active', true, true)).toEqual({ tone: 'warn', text: '⚠️ 1 分钟无新输出' })
    const old = foldActivity([event('turn.started', 0)])
    expect(phaseLine(old, 5000, 'waiting_for_approval', true, true)?.text).toBe('⚠️ 等待你的审批')
    // Which tool runs is something DSH does not show.
    const tool = foldActivity([event('turn.started', 0), event('tool.started', 0, { name: 'Grep', summary: 'Grep "foo"' }, 'g')])
    expect(phaseLine(tool, 3000, 'active', true, true)?.text).toBe('🔧 Grep "foo" · 3s')
  })
  it('names tasks by kind and progress', () => {
    const [task] = foldActivity([event('task.started', 0, { kind: 'agent', subagentType: 'Explore', description: 'Map' }, 'a'),
      event('task.progress', 1, { toolUses: 3, lastToolName: 'Grep' }, 'a')]).tasks
    expect(taskTitle(task!)).toBe('🤖 Explore · Map')
    expect(taskDetail(task!)).toBe('3 个工具 · Grep')
    expect(elapsed(3_725_000)).toBe('1h02m')
  })
})

describe('activity store', () => {
  it('reads a watched session once, merges its live events, and forgets it when unwatched', async () => {
    const rpc = vi.fn(async () => ({ data: [event('turn.started', 0), { ...event('turn.started', 0), sessionId: 'other' }] }))
    let push: ((value: JsonObject) => void) | undefined
    const stream = vi.fn(async function* (_cursor: string | undefined, signal: AbortSignal, onOpen?: () => void) {
      onOpen?.()
      while (!signal.aborted) {
        const next = await new Promise<JsonObject | undefined>(resolve => { push = resolve; signal.addEventListener('abort', () => resolve(undefined)) })
        if (next) yield { cursor: 'c', eventId: String(next['eventId']), type: 'session.event.appended' as const, timestamp: 0, resource: { kind: 'session', id: 's' }, sessionId: 's', data: next }
      }
    })
    const store = new ActivityStore(rpc, stream)
    const release = store.watch('s')
    await vi.waitFor(() => expect(store.activity('s').turn?.id).toBe('t1'))
    expect(rpc).toHaveBeenCalledWith('session_events', expect.objectContaining({ sessionId: 's', tail: true, type: expect.arrayContaining(['task.started']) }))
    push?.(event('progress', 10, { phase: 'writing' }))
    await vi.waitFor(() => expect(store.activity('s').phase?.kind).toBe('writing'))
    release()
    expect(store.activity('s').turn).toBeUndefined()
    store.dispose()
  })
})
