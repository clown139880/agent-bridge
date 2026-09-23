import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROVIDER, BridgeModelDirectory, NativeModels, installBridgeModelDirectories, modelsForWorker } from '../src/client/bridge-model-directory.js'
import type { NativeCatalog, NativeEntry } from '../src/client/native-catalog.js'

const nativeId = 'agent-bridge-session-1'
const entry: NativeEntry = {
  nativeId, sessionId: 'remote-1', workerId: 'codex@hal', model: 'gpt-5.6-sol', machineId: 'hal', workspace: '/repo',
  groupId: 'repo:test', groupTitle: 'repo', groupUpdatedAt: 1, executionLocations: [], title: 'test', status: 'idle', worker: 'HAL Codex', updatedAt: 1,
}
const claudeEntry: NativeEntry = { ...entry, workerId: 'claude@hal', model: 'claude-opus-5', worker: 'Claude @ HAL' }

function catalog(row: NativeEntry | undefined = entry): NativeCatalog {
  return {
    entry: vi.fn(() => row),
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
    const all = relayModels.map(model => ({ ...model, endpoints: model.endpoints ? [...model.endpoints] : undefined }))
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
  it('offers the routable relay models and sends an agent-bridge selection', async () => {
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, selectModel)

    const state = await directory.load()
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'claude-opus-5', 'deepseek-v4-pro', 'legacy-chat'])
    expect(state.current).toEqual({ provider: BRIDGE_PROVIDER, model: 'claude-opus-5' })

    await directory.select({ provider: BRIDGE_PROVIDER, model: 'deepseek-v4-pro' })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'deepseek-v4-pro' })
    expect(directory.store.getSnapshot().current?.model).toBe('deepseek-v4-pro')
  })

  it('falls back to the first routable model when the bound one is not offered', async () => {
    const stale: NativeEntry = { ...claudeEntry, model: 'openai-only' }
    const directory = new BridgeModelDirectory(nativeId, catalog(stale), models().source, vi.fn())
    expect((await directory.load()).current?.model).toBe('gpt-5.6-sol')
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
    expect(state.groups[0]?.models.length).toBe(4)
  })
})
