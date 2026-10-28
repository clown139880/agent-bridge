import { afterEach, describe, expect, it, vi } from 'vitest'
import { historyPage, projectRows, RemoteSessionLogs, virtualSessionId } from '../src/remote-sessions/log.js'
import { isVirtualSession } from '../src/remote-sessions/id.js'
import { installVirtualSessions, READ_ONLY, virtualTarget, wrapNamespace, VirtualSessionTransport } from '../src/client/remote-sessions.js'
import { mergeWorkspaces, type NativeEntry } from '../src/client/native-catalog.js'
import type { JsonObject, JsonValue } from '../src/types.js'

const origin = 'http://localhost:8787'
const id = virtualSessionId(origin, 'remote/含特殊字符')
const row = (eventId: string, text = eventId, turnId = 't'): JsonObject => ({ eventId, sessionId: 'r', turnId, timestamp: 100, type: 'message.completed', payload: { role: eventId === 'u' ? 'user' : 'assistant', text } })
const entry = { nativeId: id, sessionId: 'r', title: 'Remote title', groupId: 'g', groupTitle: 'Project', workspace: '/repo', updatedAt: 100, activityAt: 100, executionLocations: [] } as unknown as NativeEntry
afterEach(() => vi.useRealTimers())

describe('virtual session log', () => {
  it('uses stable origin-scoped safe ids distinct from imported ids', () => {
    expect(id).toMatch(/^bridge-remote-[a-f0-9]{64}$/)
    expect(virtualSessionId(origin + '/', 'remote/含特殊字符')).toBe(id)
    expect(virtualSessionId('http://other:8787', 'remote/含特殊字符')).not.toBe(id)
    expect(isVirtualSession(id)).toBe(true)
    expect(isVirtualSession('agent-bridge-abc')).toBe(false)
  })
  it('keeps passive turns open, deduplicates ACKs, appends dense events and closes only on a real terminal event', () => {
    const events = projectRows([row('u'), row('a')], [])
    expect(events.some(e => e.type === 'turn/end')).toBe(false)
    expect(projectRows([row('a')], events)).toEqual([])
    events.push(...projectRows([row('b')], events))
    expect(events.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(e => e.type.includes('agent-bridge/')).every(e => e.ignorable)).toBe(true)
    events.push(...projectRows([{ ...row('end'), type: 'turn.completed' }], events))
    expect(events.filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(events.map(e => e.seq)).toEqual(events.map((_, index) => index))
  })
  it('returns contiguous backwards pages without omitting turns or changing the fixed cut', () => {
    const events = projectRows([row('u'), row('a'), row('b', 'second', 't2'), row('c', 'third', 't3')], [])
    const tail = historyPage(events, events.length - 1, undefined, 1)
    const records = tail['records'] as Array<{ event: { seq: number } }>
    expect(records.at(-1)!.event.seq).toBe(events.length - 1)
    expect(tail['hasMore']).toBe(true)
    const older = historyPage(events, events.length - 1, records[0]!.event.seq, 1000)
    expect((older['records'] as unknown[]).length + records.length).toBe(events.length)
    expect(historyPage([], -1)).toEqual({ records: [], hasMore: false })
    expect(() => historyPage(events, events.length)).toThrow('cursor')
  })
  it('loads history once, reads only on a new view revision, and refuses in-place revisions', async () => {
    let rows = [row('u'), row('a')].map((r, i) => ({ ...r, cursor: `e:${i + 1}` }))
    let revision = 2, reads = 0
    const call = vi.fn(async ({ operation, args }: { operation: string; args?: JsonObject }): Promise<JsonValue> => {
      if (operation === 'session') return { sessionId: 'r', viewRevision: revision }
      if (operation === 'session_view_changes') return { hasMore: false, toRevision: revision, raw: { through: rows.length } }
      reads++
      expect(args?.['limit']).toBe(500)
      const offset = args?.['after'] ? Number(args['after']) : 0
      return { data: rows.slice(offset), nextCursor: String(rows.length), hasMore: false }
    })
    const logs = new RemoteSessionLogs({ call }, origin), virtual = virtualSessionId(origin, 'r')
    const opened = await logs.open(virtual, [{ sessionId: 'r', title: 'Title', workspace: '/repo' }])
    const snapshot = opened['snapshot'] as JsonObject
    expect(snapshot['assistantStream']).toEqual({ revision: 0 })
    expect((snapshot['projections'] as JsonObject)['values']).toMatchObject({ title: 'Title', modelSelection: { next: { provider: 'agent-bridge' } } })
    expect(reads).toBe(1)
    // Nothing changed: one session read, no history request.
    expect((await logs.poll(virtual, String(opened['epoch']), Number(snapshot['cursor'])))['records']).toEqual([])
    expect(reads).toBe(1)
    rows.push({ ...row('b'), cursor: 'e:3' }); revision++
    const delta = await logs.poll(virtual, String(opened['epoch']), Number(snapshot['cursor']))
    expect((delta['records'] as unknown[]).length).toBeGreaterThan(0)
    expect(call.mock.calls.filter(([c]) => c.operation === 'session_events').at(-1)![0].args).toMatchObject({ after: '2' })
    // Reopening a held log reads only what is new: no full reload.
    const reopened = await logs.open(virtual, [{ sessionId: 'r' }])
    expect(reopened['epoch']).toBe(opened['epoch']); expect(reads).toBe(2)
    // An in-place revision moves the revision without a new event.
    rows = [{ ...row('u', 'revision'), cursor: 'e:1' }, ...rows.slice(1)]; revision++
    await expect(logs.poll(virtual, String(opened['epoch']), Number(snapshot['cursor']))).rejects.toThrow('修订')
    const replacement = await logs.open(virtual, [{ sessionId: 'r' }])
    expect(replacement['epoch']).not.toBe(opened['epoch'])
    expect(() => logs.page(virtual, String(opened['epoch']), { throughSeq: 0 })).toThrow('重新打开')
  })
})

describe('client remote interception', () => {
  it('streams an opening snapshot and live entries, binds pages to the epoch, and aborts on unload', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn(async (operation: string): Promise<JsonValue> => operation === 'virtual_open'
      ? { epoch: 'epoch', snapshot: { type: 'snapshot', cursor: 0, records: [], assistantStream: { revision: 0 } } }
      : { records: [{ type: 'event', event: { seq: 1 } }], hasMore: false })
    const transport = new VirtualSessionTransport(rpc), stream = transport.follow(id)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: 'snapshot', cursor: 0 })
    const next = stream.next(); await vi.advanceTimersByTimeAsync(1000)
    expect((await next).value).toMatchObject({ type: 'event', event: { seq: 1 } })
    await transport.page(id, { throughSeq: 1, beforeSeq: 1 })
    expect(rpc).toHaveBeenCalledWith('virtual_page', { id, epoch: 'epoch', throughSeq: 1, beforeSeq: 1 })
    const pending = stream.next(); const aborted = expect(pending).rejects.toBeDefined()
    transport.dispose(); await aborted
  })
  it('wraps getter methods with their calling receiver and restores descriptors across reloads', () => {
    const namespace = { value: 'local' }
    Object.defineProperty(namespace, 'follow', { configurable: true, enumerable: true, get() { return () => this.value } })
    const before = Object.getOwnPropertyDescriptor(namespace, 'follow')
    for (let i = 0; i < 2; i++) {
      const restore = wrapNamespace(namespace, (_name, args, original) => virtualTarget(args) ? 'virtual' : original())
      const follow = (namespace as unknown as { follow(id: string): string }).follow
      expect(follow('local')).toBe('local'); expect(follow(id)).toBe('virtual')
      restore(); expect(Object.getOwnPropertyDescriptor(namespace, 'follow')).toEqual(before)
    }
  })
  it('registers virtual summaries, delegates locals and rejects every addressed write without Host calls', async () => {
    const host = vi.fn(async () => ({ ok: true, value: { items: [{ sessionId: 'local' }] } }))
    const session: Record<string, unknown> = {}
    for (const name of ['list', 'follow', 'page', 'projections', 'prompt', 'cancel', 'selectModel', 'attachment', 'updateQueue', 'rename', 'fork']) Object.defineProperty(session, name, { configurable: true, enumerable: true, get: () => host })
    const commands = { execute: host }, rpc = vi.fn(async () => ({}))
    const sessions = { handleSessionAdded: vi.fn(), handleSessionRemoved: vi.fn(), handleSessionStatus: vi.fn(), refresh: vi.fn(async () => {}) }
    const added = sessions.handleSessionAdded
    const dispose = installVirtualSessions({ session, commands }, sessions, rpc, { snapshot: () => [entry], subscribe: () => () => {} })
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }))
    const invoke = (name: string, args: unknown) => (session[name] as (args: unknown) => Promise<unknown>)(args)
    expect(await invoke('list', {})).toMatchObject({ value: { items: [{ sessionId: 'local' }, { sessionId: id }] } })
    host.mockClear()
    for (const name of ['prompt', 'cancel', 'selectModel', 'attachment', 'updateQueue', 'rename', 'fork']) expect(await invoke(name, { sessionId: id })).toMatchObject({ ok: false, error: { message: READ_ONLY } })
    expect(await (commands.execute as (...args: unknown[]) => unknown)(id, '/anything')).toMatchObject({ ok: false })
    expect(host).not.toHaveBeenCalled()
    await invoke('prompt', { sessionId: 'local' }); expect(host).toHaveBeenCalledOnce()
    dispose()
  })
  it('republishes only sessions whose summary changed: each publish rebuilds the native session list', () => {
    const other = { ...entry, nativeId: virtualSessionId(origin, 'other'), sessionId: 'other', title: 'Other' } as NativeEntry
    let rows = [entry, other], notify!: () => void
    const added = vi.fn(), status = vi.fn()
    const sessions = { handleSessionAdded: added, handleSessionRemoved: vi.fn(), handleSessionStatus: status, refresh: vi.fn(async () => {}) }
    const dispose = installVirtualSessions({ session: {} }, sessions, vi.fn(), { snapshot: () => rows, subscribe: listener => { notify = listener; return () => {} } })
    expect(added).toHaveBeenCalledTimes(2); expect(status).toHaveBeenCalledTimes(2)
    notify()
    expect(added).toHaveBeenCalledTimes(2)
    rows = [{ ...entry, title: 'Renamed' }, other]; notify()
    expect(added).toHaveBeenCalledTimes(3); expect(status).toHaveBeenCalledTimes(2)
    rows = [other]; notify()
    expect(sessions.handleSessionRemoved).toHaveBeenCalledWith(id)
    dispose()
  })
  it('synthesizes workspaces and hides the imported copy while preserving native sessions', () => {
    const imported = 'agent-bridge-old'
    const rows = mergeWorkspaces([{ workspaceId: 'old', path: '/presentation', title: 'Old', sessionIds: [imported], createdAt: '', updatedAt: '' }], [{ ...entry, importedId: imported } as NativeEntry])
    expect(rows.flatMap(row => row.sessionIds)).toEqual([id])
    expect(rows[0]!.title).toBe('Project')
  })
})
