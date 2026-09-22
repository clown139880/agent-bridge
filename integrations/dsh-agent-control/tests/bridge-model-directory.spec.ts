import { describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROVIDER, BridgeModelDirectory, installBridgeModelDirectories } from '../src/client/bridge-model-directory.js'
import type { NativeCatalog, NativeEntry } from '../src/client/native-catalog.js'

const nativeId = 'agent-bridge-session-1'
const entry: NativeEntry = {
  nativeId, sessionId: 'remote-1', workerId: 'codex@hal', model: 'gpt-5.6-sol', machineId: 'hal', workspace: '/repo',
  groupId: 'repo:test', groupTitle: 'repo', groupUpdatedAt: 1, executionLocations: [], title: 'test', status: 'idle', worker: 'HAL Codex', updatedAt: 1,
}

function catalog(row: NativeEntry | undefined = entry): NativeCatalog {
  return {
    entry: vi.fn(() => row),
    refresh: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  } as unknown as NativeCatalog
}

describe('BridgeModelDirectory', () => {
  it('loads only the bound worker models and sends an agent-bridge selection', async () => {
    const rpc = vi.fn(async () => ({ models: [
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'high', description: 'High' }] },
      { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
    ] }))
    const selectModel = vi.fn(async () => ({ ok: true }))
    const directory = new BridgeModelDirectory(nativeId, catalog(), rpc, selectModel)

    const state = await directory.load()
    expect(rpc).toHaveBeenCalledWith('models', { workerId: 'codex@hal' })
    expect(state.current).toEqual({ provider: BRIDGE_PROVIDER, model: 'gpt-5.6-sol', reasoningEffort: 'low' })
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])

    await directory.select({ provider: BRIDGE_PROVIDER, model: 'gpt-5.6-terra', reasoningEffort: 'high' })
    expect(selectModel).toHaveBeenCalledWith({ sessionId: nativeId, provider: BRIDGE_PROVIDER, model: 'gpt-5.6-terra', reasoningEffort: 'high' })
    expect(directory.store.getSnapshot().current?.model).toBe('gpt-5.6-terra')
  })

  it('keeps ordinary DSH sessions on the native directory', () => {
    const nativeDirectory = { store: {}, load: vi.fn(), select: vi.fn(), dispose: vi.fn() }
    const resolver = { directoryFor: vi.fn((_sessionId: string) => nativeDirectory) }
    const stop = installBridgeModelDirectories(resolver as never, catalog(), vi.fn(), vi.fn())

    expect(resolver.directoryFor('native-session')).toBe(nativeDirectory)
    expect(resolver.directoryFor(nativeId)).toBeInstanceOf(BridgeModelDirectory)
    expect(resolver.directoryFor(nativeId)).toBe(resolver.directoryFor(nativeId))
    stop()
    expect(resolver.directoryFor('native-session')).toBe(nativeDirectory)
  })

  it('rejects models that were not advertised by the session worker', async () => {
    const directory = new BridgeModelDirectory(nativeId, catalog(), vi.fn(async () => ({ models: [{ model: 'gpt-5.6-sol', displayName: 'GPT' }] })), vi.fn())
    await directory.load()
    await expect(directory.select({ provider: BRIDGE_PROVIDER, model: 'deepseek-v4' })).rejects.toThrow('不在当前 Bridge worker')
  })

  it('hides GPT models from non-Codex workers while retaining other models', async () => {
    const nonCodex: NativeEntry = { ...entry, worker: 'Claude @ HAL', executionLocations: [{ workerId: entry.workerId, workerName: 'Claude', agent: 'claude-code', machineId: 'hal', machineName: 'HAL', workspace: '/repo', online: true, available: true }] }
    const directory = new BridgeModelDirectory(nativeId, catalog(nonCodex), vi.fn(async () => ({ models: [
      { model: 'gpt-5.6-sol', displayName: 'GPT-5.6' },
      { model: 'deepseek-v4', displayName: 'DeepSeek V4' },
    ] })), vi.fn())
    const state = await directory.load()
    expect(state.groups[0]?.models.map(model => model.id)).toEqual(['deepseek-v4'])
  })
})
