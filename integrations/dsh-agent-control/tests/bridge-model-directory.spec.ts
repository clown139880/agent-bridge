import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROVIDER, BridgeModelDirectory, NativeModels, installBridgeModelDirectories } from '../src/client/bridge-model-directory.js'
import type { NativeCatalog, NativeEntry } from '../src/client/native-catalog.js'

const nativeId = 'agent-bridge-session-1'
const entry: NativeEntry = {
  nativeId, sessionId: 'remote-1', workerId: 'codex@hal', model: 'gpt-5.6-sol', machineId: 'hal', workspace: '/repo',
  groupId: 'repo:test', groupTitle: 'repo', groupUpdatedAt: 1, executionLocations: [], title: 'test', status: 'idle', worker: 'HAL Codex', updatedAt: 1,
}
const claudeEntry: NativeEntry = { ...entry, workerId: 'claude@hal', model: 'deepseek-v4', worker: 'Claude @ HAL' }

function catalog(row: NativeEntry | undefined = entry): NativeCatalog {
  return {
    entry: vi.fn(() => row),
    refresh: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  } as unknown as NativeCatalog
}

const dshCatalog = {
  default: { provider: 'tokensapi', model: 'gpt-5.6-sol' },
  groups: [
    { id: 'tokensapi', name: 'TokensAPI', models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      { id: 'deepseek-v4', name: 'DeepSeek V4' },
    ] },
    { id: 'relay', name: 'Relay', models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }, { id: 'deepseek-v4', name: 'duplicate' }] },
  ],
}

function models(load = vi.fn(async () => dshCatalog as never)) {
  return { source: new NativeModels(load), load }
}

describe('NativeModels', () => {
  it('flattens every provider group once and shares a single fetch', async () => {
    const { source, load } = models()
    const [first, second] = await Promise.all([source.load(), source.load()])
    expect(load).toHaveBeenCalledTimes(1)
    expect(first.map(model => model.id)).toEqual(['gpt-5.6-sol', 'deepseek-v4', 'claude-opus-5'])
    expect(second).toBe(first)
    source.invalidate()
    await source.load()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed catalog load', async () => {
    let fail = true
    const load = vi.fn(async () => { if (fail) throw new Error('host offline'); return dshCatalog as never })
    const source = new NativeModels(load)
    await expect(source.load()).rejects.toThrow('host offline')
    fail = false
    expect((await source.load()).length).toBe(3)
  })
})

describe('BridgeModelDirectory', () => {
  it('offers a codex worker only the GPT models and sends an agent-bridge selection', async () => {
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(), models().source, selectModel)

    const state = await directory.load()
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['gpt-5.6-sol'])
    expect(state.current).toEqual({ provider: BRIDGE_PROVIDER, model: 'gpt-5.6-sol', reasoningEffort: 'low' })

    await directory.select({ provider: BRIDGE_PROVIDER, model: 'gpt-5.6-sol', reasoningEffort: 'high' })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'gpt-5.6-sol', reasoningEffort: 'high' })
  })

  it('offers the whole catalog to workers that are not codex', async () => {
    const directory = new BridgeModelDirectory(nativeId, catalog(claudeEntry), models().source, vi.fn())
    const state = await directory.load()
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'deepseek-v4', 'claude-opus-5'])
    expect(state.current).toEqual({ provider: BRIDGE_PROVIDER, model: 'deepseek-v4' })
  })

  it('falls back to the first offered model when the bound one is not routable', async () => {
    // A codex session carrying a non-GPT model must not present it as current.
    const stale: NativeEntry = { ...entry, model: 'deepseek-v4' }
    const directory = new BridgeModelDirectory(nativeId, catalog(stale), models().source, vi.fn())
    expect((await directory.load()).current?.model).toBe('gpt-5.6-sol')
  })

  it('rejects models the bound worker cannot route', async () => {
    const directory = new BridgeModelDirectory(nativeId, catalog(), models().source, vi.fn())
    await directory.load()
    await expect(directory.select({ provider: BRIDGE_PROVIDER, model: 'deepseek-v4' })).rejects.toThrow('不在当前 Bridge worker')
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
    const load = vi.fn(async () => { if (fail) throw new Error('host offline'); return dshCatalog as never })
    const source = new NativeModels(load)
    const directory = new BridgeModelDirectory(nativeId, catalog(), source, vi.fn())
    await directory.load()
    fail = true
    source.invalidate()
    await expect(directory.load()).rejects.toThrow('host offline')
    const state = directory.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['gpt-5.6-sol'])
  })
})
