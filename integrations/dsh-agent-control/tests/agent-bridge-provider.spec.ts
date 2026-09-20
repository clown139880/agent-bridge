import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { JsonObject, JsonValue } from '../src/types.js'
import { AgentBridgeImportTarget, nativeSessionId, readHistory } from '../src/agent-bridge-provider/import-target.js'
import { ACK_EVENT, BINDING_EVENT, projectNativeEvents, projectStreamChunks } from '../src/agent-bridge-provider/mapping.js'
import { nativeSession, sessionEvents, appendSessionEvent, guardImportedTurnNumbers, type NativeHost, type NativeEvent } from '../src/agent-bridge-provider/dsh-compat.js'
import { AgentBridgeLlmAdapter } from '../src/agent-bridge-provider/adapter.js'
import { uploadPromptImages } from '../src/agent-bridge-provider/attachments.js'
import type { AgentControlService } from '../src/service.js'
import type { BridgeClient } from '../src/bridge-client.js'
import { bridgeUserInputToQuestions, userInputAnswerToBridge, relayPendingInteractions } from '../src/agent-bridge-provider/approval-bridge.js'
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(BINDING_EVENT)
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(ACK_EVENT)
const row = (id: string, type = 'message.completed', payload: JsonObject = { role: 'assistant', text: 'answer' }): JsonObject => ({
  eventId: id, sessionId: 'remote-1', turnId: 't1', itemId: id, timestamp: 10, type, payload,
})
const summary: JsonObject = { sessionId: 'remote-1', workerId: 'w', machineId: 'dev-wsl', workspace: '/remote/repo', projectIdentity: 'github.com/example/repo', groupId: 'repo:test', groupTitle: 'repo', groupUpdatedAt: 10, executionLocations: [{ workerId: 'w', machineId: 'dev-wsl', workspace: '/remote/repo' }], title: 'Remote conversation', status: 'idle', createdAt: 1, updatedAt: 10 }
const page = (data: JsonObject[], nextCursor = 'end', hasMore = false): JsonValue => ({ data, nextCursor, hasMore })
const testGroupId = (row: JsonObject) => String(row['projectIdentity'] ? 'repo:' + row['projectIdentity'] : 'loc:' + (row['machineId'] ?? row['workerId']) + ':' + row['workspace'])
const groupPage = (sessions: JsonObject[]): JsonValue => page([...new Map(sessions.map(row => [testGroupId(row), row])).entries()].map(([groupId, first]) => {
  const members = sessions.filter(row => testGroupId(row) === groupId)
  return { groupId, title: String(first['groupTitle'] ?? 'repo'), updatedAt: Math.max(...members.map(row => Number(row['updatedAt']))), executionLocations: members.map(row => ({ workerId: String(row['workerId']), machineId: String(row['machineId'] ?? row['workerId']), workspace: String(row['workspace']) })), sessions: members }
}))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(rows = [row('u', 'message.completed', { role: 'user', text: 'hello' }), row('a')]) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-provider-test-')); roots.push(root)
  const agents = new Map<string, Agent>()
  const stored = new Map<string, { header: unknown; events: readonly NativeEvent[] }>()
  const create = vi.fn(async (options: Parameters<NativeHost['agents']['create']>[0]) => {
    const session = Session.create(SessionId(options.sessionId), options.seed as never, { version: SESSION_FORMAT_VERSION, id: options.sessionId, isSeeded: false, ...options.meta } as never)
    const agent = { id: options.sessionId, session, options: options.agentOptions, status: 'idle' } as unknown as Agent
    agents.set(options.sessionId, agent)
    return { agent, dispose: async () => { agents.delete(options.sessionId) } }
  })
  const resume = vi.fn(async (options: Parameters<NativeHost['agents']['resume']>[0]) => {
    const old = stored.get(options.resumeSessionId)!
    return create({ sessionId: options.resumeSessionId, meta: old.header as never, seed: [...old.events], agentOptions: options.agentOptions })
  })
  const host: NativeHost = {
    agents: { create, resume, get: id => agents.get(id), list: () => [...agents.values()] },
    sessions: { flush: vi.fn(async value => { const session = value as Session; stored.set(String(session.id), { header: session.header, events: sessionEvents(value as never) }); return true }) },
    sessionPersistence: { stat: async id => stored.get(id) },
    workspaceRegistry: { resolveByPath: async () => undefined, create: vi.fn(async () => ({ attachSession: vi.fn(async () => {}) })) },
    emit: vi.fn(), logger: { warn: vi.fn() },
  }
  const bridge = { call: vi.fn<BridgeClient['call']>(async request => {
    if (request.operation === 'workers') return { workers: [{ id: 'w', hostname: 'remote-host', name: 'Remote worker', recentWorkspaces: [{ path: '/remote/repo', lastUsedAt: 123 }] }] }
    if (request.operation === 'session_groups') return groupPage([summary])
    if (request.operation === 'session') return summary
    if (request.operation === 'session_events') return page(request.args?.['after'] ? [] : rows)
    return page([])
  }) }
  const target = new AgentBridgeImportTarget(host, bridge, 'http://bridge.test', root)
  return { target, host, bridge, agents, stored, create, resume }
}

describe('native history projection', () => {
  it('keeps imported and cached native loop turn numbers distinct', () => {
    const session = Session.create(SessionId('turn-identity'), projectNativeEvents([row('first')], []) as never)
    guardImportedTurnNumbers(session as never)
    guardImportedTurnNumbers(session as never)
    projectNativeEvents([row('background')], sessionEvents(session as never)).forEach(event => appendSessionEvent(session as never, event))
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const events = session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2, 3])
    expect(events.at(-2)?.data).toEqual({ turn: 3, step: 1 })
    expect((events.at(-1)?.data as { turn: number }).turn).toBe(3)
  })
  it('does not reuse tool identities for repeated remote item IDs', () => {
    const events = projectNativeEvents(['one', 'two'].map(eventId => ({ ...row(eventId, 'command.completed', { command: 'pwd' }), itemId: 'same-item' })), [])
    const ids = events.filter(event => event.type === 'tool/call').map(event => event.data['callId'])
    expect(new Set(ids).size).toBe(2)
  })
  it('replays real message/command/file events through DSH Session, and appends no duplicate events', () => {
    const rows = [row('u', 'message.completed', { role: 'user', text: 'hello' }), row('a'),
      row('cmd', 'command.completed', { command: 'pwd', output: '/repo', exitCode: 0 }),
      row('files', 'file_change.completed', { changes: [{ path: 'a.ts' }] })]
    const seed = projectNativeEvents(rows, [])
    const session = Session.create(SessionId('projection'), seed as never)
    expect(session.snapshotEvents().filter(e => e.type === 'tool/call')).toHaveLength(2)
    expect(projectNativeEvents(rows, sessionEvents(session as never))).toEqual([])
    const next = projectNativeEvents([row('next')], sessionEvents(session as never))
    next.forEach(event => appendSessionEvent(session as never, event))
    expect(session.snapshotEvents().filter(e => e.type === 'assistant/message')).toHaveLength(4)
    expect(projectStreamChunks(rows[2]!)).toEqual([])
  })
  it('deduplicates legacy history ids against canonical live App Server item ids', () => {
    const liveId = 'app-server:thread-1:exec-1:command'
    const legacyId = 'app-server:thread-1:turn-1:exec-1:history-command'
    const existing: NativeEvent[] = [{ type: ACK_EVENT, data: { eventId: liveId, turnId: 'turn-1' }, seq: 0, time: 10 }]
    expect(projectNativeEvents([{ ...row(legacyId, 'command.completed', { command: 'pwd' }), itemId: 'exec-1' }], existing)).toEqual([])
    const legacyExisting: NativeEvent[] = [{ type: ACK_EVENT, data: { eventId: legacyId, turnId: 'turn-1' }, seq: 0, time: 10 }]
    expect(projectNativeEvents([{ ...row(liveId, 'command.completed', { command: 'pwd' }), itemId: 'exec-1' }], legacyExisting)).toEqual([])
  })
  it('does not re-import user items already submitted by the native turn', () => {
    const existing: NativeEvent[] = [{ type: ACK_EVENT, data: { eventId: 'action:a1:user', turnId: 'turn-1' }, seq: 0, time: 10 }]
    const historical = { ...row('app-server:thread-1:user-1:message', 'message.completed', { role: 'user', text: 'hello' }), turnId: 'turn-1' }
    expect(projectNativeEvents([historical], existing)).toEqual([])
    expect(projectNativeEvents([{ ...historical, turnId: 'external-turn' }], existing).some(event => event.type === 'user/message')).toBe(true)
  })
  it('keeps stable identity across origins and never collides with a native id', () => {
    expect(nativeSessionId('http://a/', 'same')).toBe(nativeSessionId('http://a', 'same'))
    expect(nativeSessionId('http://a', 'same')).not.toBe(nativeSessionId('http://b', 'same'))
    expect(nativeSessionId('http://a', 'same')).not.toBe('same')
  })
  it('drains opaque history pages and rejects repeated cursors or cross-session events', async () => {
    const call = vi.fn<BridgeClient['call']>(async request => request.args?.['after'] ? page([row('b')], 'done') : page([row('a')], 'opaque:next', true))
    expect((await readHistory({ call }, 'remote-1')).rows).toHaveLength(2)
    await expect(readHistory({ call: async () => page([row('a')], 'same', true) }, 'remote-1')).rejects.toThrow('advance')
    await expect(readHistory({ call: async () => page([{ ...row('a'), sessionId: 'other' }]) }, 'remote-1')).rejects.toThrow('cross-session')
  })
})

describe('native session catalog', () => {
  it('removes native visibility only after a confirmed remote delete and rejects busy sessions', async () => {
    const f = await fixture()
    await f.target.refresh()
    const id = nativeSessionId('http://bridge.test', 'remote-1')
    f.host.workspaceRegistry.archiveSession = vi.fn(async () => {})
    f.target.setBusy(id, true)
    await expect(f.target.deleteNative(id)).rejects.toThrow('当前回合')
    f.target.setBusy(id, false)
    const original = f.bridge.call.getMockImplementation()!
    f.bridge.call.mockImplementation(async (request, signal) => request.operation === 'delete_session' ? { status: 'failed', error: { message: 'offline' } } : original(request, signal))
    await expect(f.target.deleteNative(id)).rejects.toThrow('删除失败')
    expect(f.host.workspaceRegistry.archiveSession).not.toHaveBeenCalled()
    f.bridge.call.mockImplementation(async (request, signal) => request.operation === 'delete_session' ? { status: 'succeeded', sessionId: 'remote-1' } : original(request, signal))
    await f.target.deleteNative(id)
    expect(f.host.workspaceRegistry.archiveSession).toHaveBeenCalledWith(id)
    await f.target.refresh()
    expect(f.agents.has(id)).toBe(false)
  })
  it('offers only workers on the remote directory machine and never DSH on a presentation folder', async () => {
    const f = await fixture()
    const originalCall = f.bridge.call.getMockImplementation()!
    f.bridge.call.mockImplementation(async (request, signal) => request.operation === 'workers' ? {workers:[
      {id:'w',machineId:'machine-a',hostname:'remote-host',name:'Codex',status:'online'},
      {id:'claude',machineId:'machine-a',hostname:'remote-host',name:'Claude',status:'online'},
      {id:'other',machineId:'machine-b',hostname:'remote-host',name:'Other machine',status:'online'},
    ]} : originalCall(request,signal))
    await f.target.refresh()
    const agent = [...f.agents.values()][0]!
    const cwd = nativeSession(agent).header.cwd!
    const sources = (await f.target.creationSources(cwd))['sources'] as JsonObject[]
    expect(sources.map(source => source['workerId'])).toEqual(['w','claude'])
    expect(sources.every(source => source['workspace'] === '/remote/repo')).toBe(true)
    await expect(f.target.createInWorkspace(cwd,'other\0/remote/repo')).rejects.toThrow('unavailable')
    expect(f.bridge.call.mock.calls.some(([request]) => request.operation === 'create_session')).toBe(false)
    await f.target.dispose()
  })
  it('offers worker-at-machine locations from every checkout of the same repository identity', async () => {
    const f = await fixture()
    const summaries: JsonObject[] = [summary,
      { ...summary, sessionId: 'remote-2', workerId: 'windows', workspace: 'D:\\Workspace\\repo' },
      { ...summary, sessionId: 'remote-3', workerId: 'other', workspace: '/srv/repo', projectIdentity: 'github.com/example/other' }]
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'workers') return { workers: [
        { id: 'w', machineId: 'dev-wsl', hostname: 'remote-wsl', name: 'Codex', status: 'online' },
        { id: 'windows', machineId: 'windows', hostname: 'remote-windows', name: 'Claude @ Windows PC', status: 'online' },
        { id: 'other', machineId: 'hal', hostname: 'remote-hal', name: 'Codex', status: 'online' },
      ] }
      if (request.operation === 'session_groups') return groupPage(summaries)
      if (request.operation === 'session_events') return page([])
      return page([])
    })
    await f.target.refresh()
    const cwd = nativeSession(f.agents.get(nativeSessionId('http://bridge.test', 'remote-1'))!).header.cwd!
    const sources = (await f.target.creationSources(cwd))['sources'] as JsonObject[]
    expect(sources.map(source => ({ name: source['name'], machineId: source['machineId'], workspace: source['workspace'] }))).toEqual([
      { name: 'Codex @ dev-wsl', machineId: 'dev-wsl', workspace: '/remote/repo' },
      { name: 'Claude @ Windows PC', machineId: 'windows', workspace: 'D:\\Workspace\\repo' },
    ])
    await f.target.dispose()
  })
  it('automatically merges remote sessions into the native registry without touching native sessions', async () => {
    const f = await fixture()
    f.agents.set('local-session', { id: 'local-session' } as Agent)
    await f.target.refresh()
    const id = nativeSessionId('http://bridge.test', 'remote-1')
    expect([...f.agents.keys()]).toEqual(['local-session', id])
    expect(f.target.binding(id)?.['workspace']).toBe('/remote/repo')
    expect((f.target.catalog()['sessions'] as JsonObject[])[0]).toMatchObject({ lastUsedAt: 123, projectIdentity: 'github.com/example/repo' })
    expect(f.host.workspaceRegistry.create).toHaveBeenCalledWith(expect.stringContaining('groups'), 'repo')
    expect(f.stored.has(id)).toBe(true)
    await f.target.refresh()
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(sessionEvents(nativeSession(f.agents.get(id)!)).filter(e => e.type === 'user/message')).toHaveLength(1)
    await f.target.dispose()
  })
  it('single-flights opening and resumes persisted native identity without duplicating history', async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([f.target.ensure(summary), f.target.ensure(summary)])
    expect(a).toBe(b)
    expect(f.create).toHaveBeenCalledTimes(1)
    f.agents.delete(String(a.id))
    await f.target.ensure(summary)
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(sessionEvents(nativeSession(f.agents.get(String(a.id))!)).filter(e => e.type === 'assistant/message')).toHaveLength(1)
    await f.target.dispose()
  })
  it('replaces legacy per-location presentation workspaces with one durable project workspace', async () => {
    const f = await fixture([])
    const summaries = [summary, { ...summary, sessionId: 'remote-2', workerId: 'w2', workspace: 'D:\\repo' }]
    const ids = summaries.map(item => nativeSessionId('http://bridge.test', String(item['sessionId'])))
    const legacyPaths = [join(roots[0]!, 'workspaces', 'one'), join(roots[0]!, 'workspaces', 'two')]
    await Promise.all(legacyPaths.map(path => mkdir(path, { recursive: true })))
    for (let index = 0; index < ids.length; index++) {
      const session = Session.create(SessionId(ids[index]!), [], { version: SESSION_FORMAT_VERSION, id: ids[index]!, cwd: legacyPaths[index]!, createdAt: 1, isSeeded: false } as never)
      f.stored.set(ids[index]!, { header: session.header, events: [] })
    }
    const legacy = legacyPaths.map((path, index) => ({ id: 'legacy-' + index, path, title: 'repo @ machine-' + index, sessionIds: [ids[index]!], setTitle: vi.fn(async (_next: string) => {}), attachSession: vi.fn(async (_id: string) => {}) }))
    const registered = [...legacy, { id: 'stale', path: join(roots[0]!, 'workspaces', 'stale'), title: 'stale', sessionIds: [] as string[], setTitle: vi.fn(async (_next: string) => {}), attachSession: vi.fn(async (_id: string) => {}) }]
    const createWorkspace = vi.fn(async (path: string, title?: string) => {
      const workspace = { id: 'project', path, title: title ?? 'project', sessionIds: [] as string[], setTitle: vi.fn(async (next: string) => { workspace.title = next }), attachSession: vi.fn(async (id: string) => { workspace.sessionIds.unshift(id) }) }
      registered.unshift(workspace)
      return workspace
    })
    f.host.workspaceRegistry.list = () => registered
    f.host.workspaceRegistry.resolveByPath = async path => registered.find(workspace => workspace.path === path)
    f.host.workspaceRegistry.create = createWorkspace
    f.host.workspaceRegistry.delete = vi.fn(async id => { const index = registered.findIndex(workspace => workspace.id === id); if (index < 0) return false; registered.splice(index, 1); return true })
    f.host.workspaceRegistry.archiveSession = vi.fn(async () => {})
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'workers') return { workers: [{ id: 'w', machineId: 'one', hostname: 'remote', name: 'one' }, { id: 'w2', machineId: 'two', hostname: 'remote', name: 'two' }] }
      if (request.operation === 'session_groups') return groupPage(summaries)
      if (request.operation === 'session_events') return page([])
      return page([])
    })
    await f.target.refresh()
    expect(registered.map(workspace => workspace.id)).toEqual(['project'])
    expect(createWorkspace).toHaveBeenCalledWith(expect.stringContaining('groups'), 'repo')
    expect(f.host.workspaceRegistry.delete).toHaveBeenCalledTimes(3)
    expect(f.host.workspaceRegistry.archiveSession).toHaveBeenCalledTimes(2)
    expect((f.target.catalog()['sessions'] as JsonObject[]).every(item => String(item['presentationPath']).includes('groups'))).toBe(true)
    await f.target.refresh()
    expect(createWorkspace).toHaveBeenCalledTimes(1)
    await f.target.dispose()
  })
  it('converges providers sharing one machine and path even without a project identity', async () => {
    const f = await fixture([])
    const summaries: JsonObject[] = [
      { sessionId: 'remote-1', workerId: 'codex', machineId: 'dev-wsl', workspace: '/remote/repo', title: 'Codex conversation', status: 'idle', createdAt: 1, updatedAt: 10 },
      { sessionId: 'remote-2', workerId: 'claude', machineId: 'dev-wsl', workspace: '/remote/repo', title: 'Claude conversation', status: 'idle', createdAt: 1, updatedAt: 10 },
      { sessionId: 'remote-3', workerId: 'local', machineId: 'dev-wsl', workspace: '/remote/repo', title: 'Local conversation', status: 'idle', createdAt: 1, updatedAt: 10 },
    ]
    const ids = summaries.map(item => nativeSessionId('http://bridge.test', String(item['sessionId'])))
    const paths = [join(roots[0]!, 'workspaces', 'old-codex'), join(roots[0]!, 'workspaces', 'old-claude')]
    const realPath = await mkdtemp(join(tmpdir(), 'bridge-real-workspace-')); roots.push(realPath)
    await Promise.all(paths.map(path => mkdir(path, { recursive: true })))
    const registered = [...paths.map((path, index) => ({ id: 'old-' + index, path, title: 'repo · provider', sessionIds: [ids[index]!], setTitle: vi.fn(async (_next: string) => {}), attachSession: vi.fn(async (_id: string) => {}) })),
      { id: 'real', path: realPath, title: 'My repo', sessionIds: [ids[2]!], setTitle: vi.fn(async (_next: string) => {}), attachSession: vi.fn(async (_id: string) => {}) }]
    for (let index = 0; index < ids.length; index++) {
      const session = Session.create(SessionId(ids[index]!), [], { version: SESSION_FORMAT_VERSION, id: ids[index]!, cwd: paths[index] ?? realPath, createdAt: 1, isSeeded: false } as never)
      f.stored.set(ids[index]!, { header: session.header, events: [] })
    }
    const createWorkspace = vi.fn(async (path: string, title?: string) => {
      const workspace = { id: 'location', path, title: title ?? 'repo', sessionIds: [] as string[], setTitle: vi.fn(async (next: string) => { workspace.title = next }), attachSession: vi.fn(async (id: string) => { workspace.sessionIds.unshift(id) }) }
      registered.unshift(workspace)
      return workspace
    })
    f.host.workspaceRegistry.list = () => registered
    f.host.workspaceRegistry.resolveByPath = async path => registered.find(workspace => workspace.path === path)
    f.host.workspaceRegistry.create = createWorkspace
    f.host.workspaceRegistry.delete = vi.fn(async id => { const index = registered.findIndex(workspace => workspace.id === id); if (index < 0) return false; registered.splice(index, 1); return true })
    f.host.workspaceRegistry.archiveSession = vi.fn(async () => {})
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'workers') return { workers: [{ id: 'codex', machineId: 'dev-wsl', hostname: 'remote', name: 'Codex' }, { id: 'claude', machineId: 'dev-wsl', hostname: 'remote', name: 'Claude' }, { id: 'local', machineId: 'dev-wsl', hostname: 'remote', name: 'Local' }] }
      if (request.operation === 'session_groups') return groupPage(summaries)
      if (request.operation === 'session_events') return page([])
      return page([])
    })
    await f.target.refresh()
    expect(registered.map(workspace => workspace.id)).toEqual(['real'])
    expect(createWorkspace).not.toHaveBeenCalled()
    expect(new Set((f.target.catalog()['sessions'] as JsonObject[]).map(item => item['presentationPath'])).size).toBe(1)
    await f.target.dispose()
  })
  it('keeps syncing without retrying workspace attachment after a retained checkout disappears', async () => {
    const f = await fixture()
    const agent = await f.target.ensure(summary)
    const id = String(agent.id)
    const stored = f.stored.get(id)!
    const missing = join(roots[0]!, 'removed-checkout')
    stored.header = { ...(stored.header as object), cwd: missing }
    f.agents.delete(id)
    await f.target.ensure(summary)
    expect(f.host.workspaceRegistry.create).toHaveBeenCalledTimes(1)
    expect(sessionEvents(nativeSession(f.agents.get(id)!)).filter(e => e.type === 'assistant/message')).toHaveLength(1)
    await f.target.dispose()
  })
  it('does not append imported turns while the native loop is running', async () => {
    const f = await fixture()
    const agent = await f.target.ensure(summary)
    const count = sessionEvents(nativeSession(agent)).length
    f.target.setBusy(String(agent.id), true)
    await f.target.ensure({ ...summary, updatedAt: 20 })
    expect(sessionEvents(nativeSession(agent))).toHaveLength(count)
    f.target.setBusy(String(agent.id), false)
    await f.target.dispose()
  })
})

describe('Bridge native turn', () => {
  it('commits pending acknowledgement batches in turn order', () => {
    const finalizeNativeTurn = vi.fn()
    const adapter = new AgentBridgeLlmAdapter({} as AgentControlService, { finalizeNativeTurn } as unknown as AgentBridgeImportTarget)
    adapter.pendingAcks.set('native', [
      { acknowledgements: [row('first')], presentations: [row('first-tool')] },
      { acknowledgements: [row('second')], presentations: [row('second-tool')] },
    ])
    adapter.commitAcks('native')
    adapter.commitAcks('native')
    expect(finalizeNativeTurn.mock.calls.map(call => [call[1][0]['eventId'], call[2][0]['eventId']])).toEqual([
      ['first', 'first-tool'], ['second', 'second-tool'],
    ])
    expect(adapter.pendingAcks.has('native')).toBe(false)
  })
  it('uploads only current-message images through the native store and preserves repeated occurrences', async () => {
    const ref = {attachmentId:'sha256:fixture',mediaType:'image/png',name:'test.png'}
    const readImage = vi.fn(async () => ({ref,data:Buffer.from('image bytes')}))
    const agent = {ctx:{get:() => ({readImage})}} as unknown as Agent
    const call = vi.fn<BridgeClient['call']>(async () => ({id:'uploaded',filename:'test.png',mimeType:'image/png',size:11}))
    const options = {messages:[{role:'user',source:{kind:'user'},content:[{type:'image',attachment:{...ref,attachmentId:'old'}}]},
      {role:'user',source:{kind:'user'},content:[{type:'text',text:'look'},{type:'image',attachment:ref},{type:'image',attachment:ref}]}]} as unknown as GenerateOptions
    const uploaded = await uploadPromptImages(options,agent,{call},new AbortController().signal)
    expect(uploaded).toHaveLength(2)
    expect(readImage).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith({operation:'upload',args:{filename:'test.png',mimeType:'image/png',content:Buffer.from('image bytes').toString('base64')}},expect.any(AbortSignal))
    readImage.mockRejectedValueOnce(new Error('missing image'))
    await expect(uploadPromptImages(options,agent,{call},new AbortController().signal)).rejects.toThrow('missing image')
    expect(call).toHaveBeenCalledOnce()
  })
  it('settles on the matching remote turn, excludes old/foreign output and does not execute remote tools locally', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    let submitted = false
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'session_events') return page(submitted ? [
        row('foreign', 'message.completed', { role: 'assistant', text: 'foreign' }) as JsonObject,
        { ...row('wrong'), turnId: 'wrong-turn' },
        row('cmd', 'command.completed', { command: 'pwd', output: '/repo' }),
        row('done', 'turn.completed', { status: 'completed' }),
      ] : [])
      if (request.operation === 'session') return summary
      if (request.operation === 'submit_turn') { submitted = true; return { actionId: 'action', status: 'succeeded', turnId: 't1' } }
      return page([])
    })
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    const chunks = []
    for await (const chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'remote',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) chunks.push(chunk)
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(chunks.filter(c => c.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'foreign' }])
    expect(chunks.filter(c => c.type === 'block-start')).toHaveLength(1)
    expect(chunks.filter(c => c.type === 'block-end')).toHaveLength(1)
    expect(chunks.some(c => c.type === 'tool-call-delta')).toBe(false)
    adapter.commitAcks(String(agent.id))
    expect(sessionEvents(nativeSession(agent)).some(e => e.data['eventId'] === 'foreign')).toBe(true)
    const events = sessionEvents(nativeSession(agent))
    expect(events.filter(e => e.type === 'tool/call')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(1)
    expect(events.find(e => e.type === 'tool/call')?.data).toMatchObject({ name: 'agent-bridge:command', arguments: JSON.stringify({ command: 'pwd' }) })
    expect(events.find(e => e.type === 'tool/result')?.data['message']).toMatchObject({ content: [{ type: 'tool-result', content: [{ type: 'text', text: '/repo' }] }] })
    expect(events.some(e => e.type === ACK_EVENT && e.data['eventId'] === 'cmd')).toBe(true)
    expect(f.target.isPresenting(String(agent.id))).toBe(false)
    await f.target.dispose()
  })
  it('forwards a worker-scoped model selection on a new Bridge turn', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    let submitted = false
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'session') return summary
      if (request.operation === 'submit_turn') { submitted = true; return { status: 'succeeded', turnId: 't1' } }
      if (request.operation === 'session_events') return page(submitted ? [row('done', 'turn.completed', { status: 'completed' })] : [])
      return page([])
    })
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    for await (const _chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'gpt-5.6-sol', reasoningEffort: 'high',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) { /* drain */ }
    expect(f.bridge.call).toHaveBeenCalledWith({ operation: 'submit_turn', args: {
      sessionId: 'remote-1', input: 'go', delivery: 'auto', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    } }, expect.any(AbortSignal))
    await f.target.dispose()
  })
  it('maps live Bridge deltas to native text and reasoning blocks without replaying the completed text', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    let submitted = false
    let historyReads = 0
    let liveDelivered = false
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'session') return summary
      if (request.operation === 'submit_turn') { submitted = true; return { actionId: 'live', status: 'succeeded', turnId: 't1' } }
      if (request.operation === 'live_events') {
        if (!request.args?.['after']) return { data: [], nextCursor: 'l:0' }
        if (!liveDelivered) {
          liveDelivered = true
          return { data: [
            { cursor: 'l:1', sessionId: 'remote-1', turnId: 't1', itemId: 'answer', blockId: 'text:answer', deltaType: 'text', delta: 'Hel', timestamp: 11 },
            { cursor: 'l:2', sessionId: 'remote-1', turnId: 't1', itemId: 'thought', blockId: 'reasoning:thought:summary:0', deltaType: 'reasoning', delta: 'Checking', timestamp: 12 },
          ], nextCursor: 'l:2' }
        }
        return { data: [], nextCursor: 'l:2' }
      }
      if (request.operation === 'session_events') {
        if (!submitted) return page([])
        historyReads++
        return historyReads === 1 ? page([]) : page([
          { ...row('answer', 'message.completed', { role: 'assistant', text: 'Hello' }), itemId: 'answer' },
          row('done', 'turn.completed', { status: 'completed' }),
        ])
      }
      return page([])
    })
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    const chunks = []
    for await (const chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'remote',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) chunks.push(chunk)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: 'Hel' }])
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toEqual([{ type: 'reasoning-delta', index: 1, text: 'Checking' }])
    expect(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 0)).toMatchObject({ block: { type: 'text', text: 'Hello' } })
    expect(chunks.at(-1)?.type).toBe('finish')
    await f.target.dispose()
  })
  it('reports failed receipts rather than emitting a successful finish', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    f.bridge.call.mockImplementation(async request => request.operation === 'session_events' ? page([]) :
      request.operation === 'submit_turn' ? { actionId: 'a', status: 'failed', error: { message: 'offline' } } : summary)
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    const run = async () => { for await (const _chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'remote', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) { /* drain */ } }
    await expect(run()).rejects.toThrow('failed')
    await f.target.dispose()
  })
  it('finishes an idle turn when retained history repeats without a cursor or completion event', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    let submitted = false
    f.bridge.call.mockImplementation(async request => {
      if (request.operation === 'session_events') return page(submitted ? [row('answer', 'message.completed', { role: 'assistant', text: 'done' })] : [])
      if (request.operation === 'session') return { ...summary, status: 'idle', activeTurnId: null }
      if (request.operation === 'submit_turn') { submitted = true; return { status: 'succeeded', turnId: 't1' } }
      return page([])
    })
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    const chunks = []
    for await (const chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'remote', signal: AbortSignal.timeout(1000), messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) chunks.push(chunk)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe('finish')
    await f.target.dispose()
  })
  it('rejects successful actions without a turn identity instead of polling forever', async () => {
    const f = await fixture([])
    const agent = await f.target.ensure(summary)
    f.bridge.call.mockImplementation(async request => request.operation === 'session_events' ? page([]) :
      request.operation === 'submit_turn' ? { actionId: 'a', status: 'succeeded' } : { ...summary, activeTurnId: null })
    const adapter = new AgentBridgeLlmAdapter({ bridge: f.bridge } as unknown as AgentControlService, f.target, 1)
    const run = async () => { for await (const _chunk of adapter.stream({ sessionId: agent.id, provider: 'agent-bridge', model: 'remote', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] } as GenerateOptions)) { /* drain */ } }
    await expect(run()).rejects.toThrow('without a turn identity')
    await f.target.dispose()
  })
})

describe('pending question mapping', () => {
  it('uses the injected Host services for an idle remote approval instead of the isolated Agent context', async () => {
    const ask = vi.fn(async () => ({answers:[{id:'decision',selected:['deny']}]}))
    const agent = {status:'idle',ctx:new Proxy({}, {get:() => {throw new Error('without inject')}})} as unknown as Agent
    const services = {userQuestions:{ask},logger:{warn:vi.fn()}} as unknown as Context
    const call = vi.fn<BridgeClient['call']>(async request => {
      if (request.operation === 'approvals') return page([{id:'approval',sessionId:'remote-1',status:'pending',summary:'write tmp',choices:['allow','deny','allow-session']}])
      if (request.operation === 'approval') return {status:'pending'}
      return page([])
    })
    const jobs = new Map<string,Promise<void>>()
    await relayPendingInteractions({call},agent,'remote-1',jobs,new AbortController().signal,services)
    await Promise.all(jobs.values())
    expect(ask).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith({operation:'resolve_approval',args:{approvalId:'approval',choice:'deny'}},expect.any(AbortSignal))
  })
  it('cancels an obsolete native question when the remote approval disappears', async () => {
    let pending = true
    let aborted = false
    const ask = ({signal}: {signal:AbortSignal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',() => {aborted=true;reject(new Error('cancelled'))},{once:true}))
    const services = {userQuestions:{ask},logger:{warn:vi.fn()}} as unknown as Context
    const agent = {status:'idle'} as Agent
    const call = vi.fn<BridgeClient['call']>(async request => request.operation === 'approvals' && pending ? page([{id:'p',sessionId:'r',status:'pending',choices:['allow','deny','allow-session']}]) : page([]))
    const jobs = new Map<string,Promise<void>>()
    await relayPendingInteractions({call},agent,'r',jobs,new AbortController().signal,services)
    const active = [...jobs.values()]
    pending=false
    await relayPendingInteractions({call},agent,'r',jobs,new AbortController().signal,services)
    await Promise.all(active)
    expect(aborted).toBe(true)
    expect(jobs.size).toBe(0)
    expect(services.logger.warn).not.toHaveBeenCalled()
  })
  it('preserves multiple selected answers and rejects secret questions', () => {
    const pending = { id: 'q', questions: [{ id: 'one', question: 'Which?' }] }
    expect(userInputAnswerToBridge(pending, { answers: [{ id: 'one', selected: ['a', 'b'], custom: 'c' }] })).toEqual({ requestId: 'q', answers: { one: { answers: ['a', 'b', 'c'] } } })
    expect(() => bridgeUserInputToQuestions({ questions: [{ id: 'secret', isSecret: true }] })).toThrow('Secret')
  })
})

describe('local DSH deletion', () => {
  it('removes only the chosen idle local record, keeps its log, and restores the deletion after reload', async () => {
    const f = await fixture()
    f.stored.set('session-local', { header: { id: 'session-local' }, events: [] })
    const archive = vi.fn(async () => {})
    f.host.workspaceRegistry.archiveSession = archive
    expect(await f.target.deleteNative('session-local')).toEqual({ deleted: true, nativeId: 'session-local' })
    expect(archive).toHaveBeenCalledWith('session-local')
    expect(f.bridge.call).not.toHaveBeenCalled()
    expect(f.stored.has('session-local')).toBe(true)
    archive.mockClear()
    const restarted = new AgentBridgeImportTarget(f.host, f.bridge, f.target.origin, f.target.dataRoot)
    await restarted.restoreLocalDeletions()
    expect(archive).toHaveBeenCalledWith('session-local')
    await expect(f.target.deleteNative('../outside')).rejects.toThrow('无效')
    await expect(f.target.deleteNative('agent-bridge-unloaded')).rejects.toThrow('尚未加载')
    f.agents.set('session-local', { status: 'running', session: Session.create(SessionId('session-local'), []) } as unknown as Agent)
    await expect(f.target.deleteNative('session-local')).rejects.toThrow('请先结束')
  })
})
