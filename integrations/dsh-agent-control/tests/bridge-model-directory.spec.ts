import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROVIDER, BridgeModelDirectory, NativeModels, REMOTE_MODEL, groupIdOf, groupModels, installBridgeModelDirectories, modelsForWorker, withAgentEfforts } from '../src/client/bridge-model-directory.js'
import type { NativeCatalog, NativeEntry } from '../src/client/native-catalog.js'

const nativeId = 'agent-bridge-session-1'
const entry: NativeEntry = {
  nativeId, sessionId: 'remote-1', workerId: 'codex@hal', model: 'gpt-5.6-sol', machineId: 'hal', workspace: '/repo',
  groupId: 'repo:test', groupTitle: 'repo', groupUpdatedAt: 1, executionLocations: [], title: 'test', status: 'idle', worker: 'HAL Codex', updatedAt: 1, activityAt: 1,
}
const claudeEntry: NativeEntry = { ...entry, workerId: 'claude@hal', model: 'claude-opus-5', worker: 'Claude @ HAL' }

function catalog(row: NativeEntry | undefined = entry, others: NativeEntry[] = []): NativeCatalog {
  return {
    entry: vi.fn(() => row),
    snapshot: vi.fn(() => [...(row ? [row] : []), ...others]),
    refresh: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  } as unknown as NativeCatalog
}

const ALL_WIRES = ['openai', 'openai-response', 'anthropic']
const relayModels = [
  { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', endpoints: ALL_WIRES },
  { id: 'claude-opus-5', name: 'claude-opus-5', endpoints: ALL_WIRES },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', endpoints: ALL_WIRES },
  { id: 'legacy-chat', name: 'legacy-chat' },
  { id: 'openai-only', name: 'openai-only', endpoints: ['openai'] },
]

function models(rpc = vi.fn(async () => ({ models: relayModels }) as never)) {
  return { source: new NativeModels(rpc), rpc }
}

describe('NativeModels', () => {
  it('reads the host relay catalog once and shares a single request', async () => {
    const { source, rpc } = models()
    const [first, second] = await Promise.all([source.load(), source.load()])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('provider_models')
    expect(first.map(model => model.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'deepseek-v4-pro', 'legacy-chat', 'openai-only'])
    expect(second).toBe(first)
    source.invalidate()
    await source.load()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed load', async () => {
    let fail = true
    const rpc = vi.fn(async () => { if (fail) throw new Error('host offline'); return { models: relayModels } as never })
    const source = new NativeModels(rpc)
    await expect(source.load()).rejects.toThrow('host offline')
    fail = false
    expect((await source.load()).length).toBe(5)
  })
})

describe('modelsForWorker', () => {
  it('keeps what each agent transport can reach, by declared endpoint rather than by name', () => {
    const all = relayModels.map(model => ({ ...model, ...(model.endpoints ? { endpoints: [...model.endpoints] } : {}) }))
    // Claude is not restricted to claude-named models: the relay serves every
    // model over the anthropic wire.
    expect(modelsForWorker(claudeEntry, all).map(m => m.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'deepseek-v4-pro', 'legacy-chat'])
    // Codex is not restricted to gpt-named models either.
    expect(modelsForWorker(entry, all).map(m => m.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'deepseek-v4-pro', 'legacy-chat'])
    expect(modelsForWorker({ ...entry, workerId: 'pi@hal', worker: 'Pi @ HAL' }, all).map(m => m.id))
      .toEqual(['gpt-5.6-sol', 'claude-opus-5', 'deepseek-v4-pro', 'legacy-chat', 'openai-only'])
  })

  it('resolves the agent from the execution location when the worker id has no prefix', () => {
    const legacy: NativeEntry = { ...entry, workerId: 'worker-1', worker: 'HAL', executionLocations: [
      { workerId: 'worker-1', workerName: 'Claude', agent: 'claude-code', machineId: 'hal', machineName: 'HAL', workspace: '/repo', online: true, available: true },
    ] }
    expect(modelsForWorker(legacy, [{ id: 'a', name: 'a', endpoints: ['anthropic'] }, { id: 'b', name: 'b', endpoints: ['openai'] }]).map(m => m.id)).toEqual(['a'])
  })

  it('offers everything when the agent cannot be identified', () => {
    const unknown: NativeEntry = { ...entry, workerId: 'mystery', worker: 'mystery' }
    expect(modelsForWorker(unknown, [{ id: 'a', name: 'a', endpoints: ['openai'] }]).map(m => m.id)).toEqual(['a'])
  })
})

describe('BridgeModelDirectory', () => {
  it('groups the routable relay models by family behind a Remote auto choice', async () => {
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, selectModel)

    const state = await directory.load()
    expect(state.groups.map(group => [group.name, group.models.map(model => model.id)])).toEqual([
      ['自动', [REMOTE_MODEL]], ['Claude', ['claude-opus-5']], ['OpenAI', ['gpt-5.6-sol']], ['DeepSeek', ['deepseek-v4-pro']], ['其他', ['legacy-chat']],
    ])
    expect(state.current).toEqual({ provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5' })
    expect(selectModel).not.toHaveBeenCalled()

    await directory.select({ provider: groupIdOf('deepseek-v4-pro'), model: 'deepseek-v4-pro' })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'deepseek-v4-pro' })
    expect(directory.store.getSnapshot().current).toEqual({ provider: groupIdOf('deepseek-v4-pro'), model: 'deepseek-v4-pro' })
  })

  it('orders a family newest-looking first', () => {
    const groups = groupModels([{ id: 'claude-opus-4-8', name: 'a' }, { id: 'claude-opus-5-5', name: 'b' }, { id: 'claude-opus-5', name: 'c' }])
    expect(groups[1]?.models.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'])
  })

  it('starts a new session on the most recently used model and applies it for real', async () => {
    const fresh: NativeEntry = { ...claudeEntry, model: undefined as never }
    const older: NativeEntry = { ...claudeEntry, nativeId: 'agent-bridge-old', model: 'claude-opus-5', lastUsedAt: 10 }
    const newer: NativeEntry = { ...claudeEntry, nativeId: 'agent-bridge-new', model: 'deepseek-v4-pro', lastUsedAt: 20 }
    const codex: NativeEntry = { ...entry, nativeId: 'agent-bridge-codex', model: 'gpt-5.6-sol', lastUsedAt: 30 }
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(fresh, [older, newer, codex]), models().source, selectModel)

    expect((await directory.load()).current?.model).toBe('deepseek-v4-pro')
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'deepseek-v4-pro' })
  })

  it('shows Remote auto on a new session with no usable history instead of the first row', async () => {
    const fresh: NativeEntry = { ...claudeEntry, model: undefined as never }
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(fresh), models().source, selectModel)
    expect((await directory.load()).current).toEqual({ provider: groupIdOf(REMOTE_MODEL), model: REMOTE_MODEL })
    expect(selectModel).not.toHaveBeenCalled()
  })

  it('shows Remote auto when the bound model is no longer offered', async () => {
    const stale: NativeEntry = { ...claudeEntry, model: 'openai-only' }
    const directory = new BridgeModelDirectory(nativeId, catalog(stale), models().source, vi.fn())
    expect((await directory.load()).current?.model).toBe(REMOTE_MODEL)
  })

  it('rejects models the bound worker cannot route', async () => {
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, vi.fn())
    await directory.load()
    await expect(directory.select({ provider: BRIDGE_PROVIDER, model: 'openai-only' })).rejects.toThrow('不在当前 Bridge worker')
  })

  it('keeps ordinary DSH sessions on the native directory', () => {
    const nativeDirectory = { store: {}, load: vi.fn(), select: vi.fn(), dispose: vi.fn() }
    const resolver = { directoryFor: vi.fn((_sessionId: string) => nativeDirectory) }
    const stop = installBridgeModelDirectories(resolver as never, catalog(), models().source, vi.fn())

    expect(resolver.directoryFor('native-session')).toBe(nativeDirectory)
    expect(resolver.directoryFor(nativeId)).toBeInstanceOf(BridgeModelDirectory)
    expect(resolver.directoryFor(nativeId)).toBe(resolver.directoryFor(nativeId))
    stop()
    expect(resolver.directoryFor('native-session')).toBe(nativeDirectory)
  })
})

describe('effort levels', () => {
  it('provides the current native selector pending state and successful RPC result', async () => {
    let finish!: (value: { ok: boolean }) => void
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source,
      () => new Promise(resolve => { finish = resolve }))
    expect(directory.store.getSnapshot().pending).toBeNull()
    await directory.load()
    expect(directory.store.getSnapshot().pending).toBeNull()
    const selection = { provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5', reasoningEffort: 'max' }
    const operation = directory.select(selection)
    expect(directory.store.getSnapshot().pending).toEqual(selection)
    finish({ ok: true })
    await expect(operation).resolves.toEqual({ ok: true, value: undefined })
    expect(directory.store.getSnapshot().pending).toBeNull()
    expect(directory.store.getSnapshot().current).toEqual(selection)
  })

  it('clears pending and returns the Host error without discarding the model menu', async () => {
    const error = { code: 'session/writer-held', message: 'busy' }
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, async () => ({ ok: false, error }))
    await directory.load()
    await expect(directory.select({ provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5' })).resolves.toEqual({ ok: false, error })
    expect(directory.store.getSnapshot().pending).toBeNull()
    expect(directory.store.getSnapshot().groups.length).toBeGreaterThan(0)
  })
  const ids = (state: Awaited<ReturnType<BridgeModelDirectory['load']>>) =>
    state.groups.map(group => group.models.map(model => model.reasoning?.efforts.map(effort => effort.id) ?? []))

  it('offers the levels of the worker agent on every model, Remote auto included', async () => {
    const claude = await new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, vi.fn()).load()
    for (const levels of ids(claude).flat()) expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(claude.groups.flatMap(group => group.models).every(model => model.reasoning?.defaultEffort === undefined)).toBe(true)
    const codex = await new BridgeModelDirectory(nativeId, catalog(entry), models().source, vi.fn()).load()
    for (const levels of ids(codex).flat()) expect(levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    // Pi ignores effort, so it offers none.
    expect(withAgentEfforts({ ...entry, workerId: 'pi@hal', worker: 'Pi' }, [{ id: 'a', name: 'a' }])[0]?.reasoning).toBeUndefined()
  })

  it('sends the picked level and shows it again when the session is reopened', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) } })
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, selectModel)
    await directory.load()
    await directory.select({ provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5', reasoningEffort: 'max' })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'claude-opus-5', reasoningEffort: 'max' })
    expect((await directory.load()).current?.reasoningEffort).toBe('max')

    const reopened = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, vi.fn())
    expect((await reopened.load()).current).toEqual({ provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5', reasoningEffort: 'max' })
    // A level this agent does not take is not shown.
    const codex = new BridgeModelDirectory(nativeId, catalog(entry), models().source, vi.fn())
    expect((await codex.load()).current?.reasoningEffort).toBeUndefined()

    await directory.select({ provider: groupIdOf('claude-opus-5'), model: 'claude-opus-5' })
    const cleared = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, vi.fn())
    expect((await cleared.load()).current?.reasoningEffort).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('BridgeModelDirectory rendering', () => {
  it('does not notify subscribers when a reload produces the same snapshot', async () => {
    const directory = new BridgeModelDirectory(nativeId, catalog(), models().source, vi.fn())
    await directory.load()
    const listener = vi.fn()
    directory.store.subscribe(listener)
    await directory.load()
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps a loaded menu on screen when a reload fails', async () => {
    let fail = false
    const rpc = vi.fn(async () => { if (fail) throw new Error('host offline'); return { models: relayModels } as never })
    const source = new NativeModels(rpc)
    const directory = new BridgeModelDirectory(nativeId, catalog(), source, vi.fn())
    await directory.load()
    fail = true
    source.invalidate()
    await expect(directory.load()).rejects.toThrow('host offline')
    const state = directory.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.groups.flatMap(group => group.models).length).toBe(5)
  })
})
