import { describe, expect, it } from 'vitest'
import { mergeWorkspaces, NativeCatalog, sourceLabel, type NativeEntry, type WorkspaceRow } from '../src/client/native-catalog.js'
import { promptTitle } from '../src/agent-bridge-provider/import-target.js'
import type { NativeEvent } from '../src/agent-bridge-provider/dsh-compat.js'

const entry = (nativeId: string, machineId = 'dev-wsl', workspace = '/work/agent-bridge', lastUsedAt?: number, projectIdentity?: string, updatedAt = 0): NativeEntry => ({ nativeId, machineId, workspace, sessionId: nativeId, groupId: projectIdentity ? `repo:${projectIdentity}` : `loc:${machineId}:${workspace}`, groupTitle: projectIdentity ? 'agent-bridge' : `agent-bridge @ ${machineId}`, groupUpdatedAt: updatedAt, executionLocations: [{ workerId: 'worker', workerName: 'worker', machineId, machineName: machineId, workspace, online: true, available: true }], title: 'test', status: 'idle', worker: 'worker', updatedAt, ...(lastUsedAt === undefined ? {} : { lastUsedAt }), ...(projectIdentity ? { projectIdentity } : {}) })
const workspace = (id: string): WorkspaceRow => ({ workspaceId: id, path: '/presentation/' + id, title: 'agent-bridge · Codex @ dev-wsl', sessionIds: [id], createdAt: '2026-01-01', updatedAt: '2026-01-01' })
describe('native catalog', () => {
  it('does not flash ungrouped Bridge workspaces before the first catalog fetch', () => {
    const bridgeOnly = { ...workspace('bridge'), sessionIds: ['agent-bridge-one', 'agent-bridge-two'] }
    const mixed = { ...workspace('mixed'), sessionIds: ['session-native', 'agent-bridge-three'] }
    expect(mergeWorkspaces([bridgeOnly, mixed], [], false)).toEqual([
      { ...mixed, sessionIds: ['session-native'] },
    ])
  })
  it('merges legacy presentation groups containing native blank sessions and stale ids', () => {
    const rows = ['codex','claude'].map(id => ({...workspace(id),path:'C:\\Users\\test\\.dsh\\agent-bridge\\workspaces\\'+id,sessionIds:['native-blank-'+id,id,'stale-'+id]}))
    const merged = mergeWorkspaces(rows,[entry('codex'),entry('claude')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sessionIds).toEqual(['codex', 'claude'])
    expect(merged[0]?.title).toBe('agent-bridge @ dev-wsl')
    expect(mergeWorkspaces(rows,[entry('codex'),entry('claude','other-machine')])).toHaveLength(2)
  })
  it('merges only equal machine and actual path, preserving original identities and source snapshots', () => {
    const rows = ['codex', 'claude', 'hal', 'different', 'local'].map(workspace)
    const merged = mergeWorkspaces(rows, [entry('codex'), entry('claude'), entry('hal', 'hal'), entry('different', 'dev-wsl', '/other/agent-bridge')])
    expect(merged).toHaveLength(4)
    expect(merged[0]?.sessionIds).toEqual(['codex', 'claude'])
    expect(merged[0]?.title).toBe('agent-bridge @ dev-wsl')
    expect(rows[0]?.sessionIds).toEqual(['codex'])
    expect(merged.at(-1)).toBe(rows.at(-1))
  })
  it('merges the same repository across machines without guessing missing or different identities', () => {
    const rows = ['wsl', 'windows', 'other-repository', 'unknown'].map(workspace)
    const merged = mergeWorkspaces(rows, [
      entry('wsl', 'dev-wsl', '/work/agent-bridge', 100, 'github.com/example/agent-bridge'),
      entry('windows', 'windows', 'D:\\Workspace\\agent-bridge', 500, 'github.com/example/agent-bridge'),
      entry('other-repository', 'windows', 'D:\\Other\\agent-bridge', 300, 'github.com/example/other'),
      entry('unknown', 'windows', 'D:\\Unknown\\agent-bridge', 200),
    ])
    expect(merged).toHaveLength(3)
    expect(merged[0]?.sessionIds).toEqual(['wsl', 'windows'])
    expect(merged[0]?.title).toBe('agent-bridge')
    expect(merged.map(row => row.workspaceId)).toEqual(['wsl', 'other-repository', 'unknown'])
  })
  it('merges a real local workspace with native sessions when known identities agree', () => {
    const local = { ...workspace('local'), path: 'C:\\Users\\test\\Workspace\\agent-bridge', title: 'agent-bridge', sessionIds: ['session-native', 'local-bridge'] }
    const remote = { ...workspace('remote'), sessionIds: ['remote-bridge'] }
    const localEntry = entry('local-bridge', 'windows', local.path, 100, 'github.com/example/agent-bridge')
    localEntry.executionLocations[0]!.local = true
    const merged = mergeWorkspaces([local, remote], [
      localEntry,
      entry('remote-bridge', 'hal.local', '/work/agent-bridge', 200, 'github.com/example/agent-bridge'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sessionIds).toEqual(['local-bridge', 'remote-bridge', 'session-native'])
    expect(merged[0]?.title).toBe('agent-bridge')
  })
  it('does not merge a workspace whose known members have conflicting identities', () => {
    const mixed = { ...workspace('mixed'), sessionIds: ['one', 'two', 'session-native'] }
    const sibling = { ...workspace('sibling'), sessionIds: ['three'] }
    expect(mergeWorkspaces([mixed, sibling], [
      entry('one', 'windows', '/work/shared', 100, 'github.com/example/one'),
      entry('two', 'windows', '/work/shared', 100, 'github.com/example/two'),
      entry('three', 'hal.local', '/work/shared', 100, 'github.com/example/one'),
    ])).toHaveLength(2)
  })
  it('uses the authoritative server group title', () => {
    expect(mergeWorkspaces([{ ...workspace('a'), title: '我的项目' }], [entry('a')])[0]?.title).toBe('agent-bridge @ dev-wsl')
  })
  it('orders workspaces by recent worker activity and leaves unknown activity last', () => {
    const rows = ['unknown-a', 'older', 'newer', 'unknown-b'].map(workspace)
    const merged = mergeWorkspaces(rows, [
      entry('unknown-a', 'dev-wsl', '/work/unknown-a'),
      entry('older', 'dev-wsl', '/work/older', 100),
      entry('newer', 'dev-wsl', '/work/newer', 300),
      entry('unknown-b', 'dev-wsl', '/work/unknown-b'),
    ])
    expect(merged.map(row => row.workspaceId)).toEqual(['unknown-a', 'older', 'newer', 'unknown-b'])
  })
  it('uses the newest activity when presentation workspaces merge', () => {
    const rows = ['first', 'second', 'other'].map(workspace)
    const merged = mergeWorkspaces(rows, [entry('first', 'dev-wsl', '/work/shared', 10), entry('second', 'dev-wsl', '/work/shared', 500), entry('other', 'dev-wsl', '/work/other', 100)])
    expect(merged.map(row => row.workspaceId)).toEqual(['first', 'other'])
    expect(merged[0]?.sessionIds).toEqual(['first', 'second'])
  })
  it('orders merged Bridge sessions globally by their own update time', () => {
    const local = { ...workspace('local'), sessionIds: ['native-a', 'older', 'native-b', 'newest'] }
    const remote = { ...workspace('remote'), sessionIds: ['middle'] }
    const merged = mergeWorkspaces([local, remote], [
      entry('older', 'windows', 'C:\\repo', 10, 'repo', 100),
      entry('newest', 'windows', 'C:\\repo', 10, 'repo', 300),
      entry('middle', 'hal', '/repo', 10, 'repo', 200),
    ])
    expect(merged[0]?.sessionIds).toEqual(['older', 'newest', 'middle'])
  })
  it('fills an empty unified presentation workspace with catalog sessions', () => {
    const row = { ...workspace('project'), path: 'C:\\data\\projects\\repo', title: 'repo', sessionIds: [] }
    const catalog = [
      { ...entry('old', 'hal', '/repo', 10, 'repo', 100), presentationPath: row.path },
      { ...entry('new', 'windows', 'D:\\repo', 10, 'repo', 200), presentationPath: row.path },
    ]
    expect(mergeWorkspaces([row], catalog)[0]?.sessionIds).toEqual(['old', 'new'])
  })
  it('projects current catalog sessions out of the durable archive set', async () => {
    const row = { ...workspace('project'), path: 'C:\\data\\projects\\repo', sessionIds: [] }
    const current = { ...entry('agent-bridge-current', 'hal', '/repo', 10, 'repo', 200), presentationPath: row.path }
    const source = {
      getSnapshot: () => ({ items: [row], archivedSessionIds: [current.nativeId, 'agent-bridge-deleted', 'native-archived'] }),
      subscribe: () => () => {},
    }
    const catalog = new NativeCatalog(async () => ({ sessions: [current] }), { list: { getSnapshot: () => ({}), subscribe: () => () => {} }, clear() {}, async refresh() {} })
    await catalog.refresh()
    const dispose = catalog.install({ list: source, async rename() {}, async delete() {}, async insertSessionBefore() {} })
    expect(source.getSnapshot()).toMatchObject({
      items: [{ sessionIds: [current.nativeId] }],
      archivedSessionIds: ['agent-bridge-deleted', 'native-archived'],
    })
    dispose()
  })
  it('renders worker, machine, and physical workspace in compact source metadata', async () => {
    const remote = entry('remote', 'hal', '/srv/repo', 1, 'repo', 2)
    remote.worker = 'Codex @ HAL'; remote.executionLocations[0]!.machineName = 'HAL Server'
    const source = { getSnapshot: () => ({ items: [workspace('local')], archivedSessionIds: [] }), subscribe: () => () => {} }
    const sessions = { list: { getSnapshot: () => ({ current: 'remote' }), subscribe: () => () => {} }, clear() {}, async refresh() {} }
    const catalog = new NativeCatalog(async () => ({ sessions: [remote] }), sessions)
    await catalog.refresh(); const dispose = catalog.install({ list: source, async rename() {}, async delete() {}, async insertSessionBefore() {} })
    expect(sourceLabel(catalog.source('remote'))).toBe('Codex @ HAL · HAL Server (hal) · /srv/repo')
    expect(sourceLabel(catalog.source('local'))).toBe('Local DSH · 本机 · /presentation/local')
    dispose()
  })
  it('uses the first real user prompt, recovers backfilled prompts and preserves useful titles', () => {
    const user = (text: string): NativeEvent => ({ type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    expect(promptTitle({ sessionId: '123', title: 'Bridge · 123' }, [user('调研\n模型部署')])).toBe('调研 模型部署')
    expect(promptTitle({ title: '手动命名' }, [user('hello')])).toBe('手动命名')
    expect(promptTitle({}, [user('继续'), user('【恢复的首条用户消息】\n最初的任务')])).toBe('最初的任务')
    expect(promptTitle({}, [user('中'.repeat(100))])).toHaveLength(65)
  })
})
