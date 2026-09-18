import { describe, expect, it } from 'vitest'
import { mergeWorkspaces, type NativeEntry, type WorkspaceRow } from '../src/client/native-catalog.js'
import { promptTitle } from '../src/agent-bridge-provider/import-target.js'
import type { NativeEvent } from '../src/agent-bridge-provider/dsh-compat.js'

const entry = (nativeId: string, machineId = 'dev-wsl', workspace = '/work/agent-bridge', lastUsedAt?: number, projectIdentity?: string): NativeEntry => ({ nativeId, machineId, workspace, sessionId: nativeId, title: 'test', status: 'idle', worker: 'worker', ...(lastUsedAt === undefined ? {} : { lastUsedAt }), ...(projectIdentity ? { projectIdentity } : {}) })
const workspace = (id: string): WorkspaceRow => ({ workspaceId: id, path: '/presentation/' + id, title: 'agent-bridge · Codex @ dev-wsl', sessionIds: [id], createdAt: '2026-01-01', updatedAt: '2026-01-01' })
describe('native catalog', () => {
  it('merges legacy presentation groups containing native blank sessions and stale ids', () => {
    const rows = ['codex','claude'].map(id => ({...workspace(id),path:'C:\\Users\\test\\.dsh\\agent-bridge\\workspaces\\'+id,sessionIds:['native-blank-'+id,id,'stale-'+id]}))
    const merged = mergeWorkspaces(rows,[entry('codex'),entry('claude')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sessionIds).toHaveLength(6)
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
  it('preserves custom group titles', () => {
    expect(mergeWorkspaces([{ ...workspace('a'), title: '我的项目' }], [entry('a')])[0]?.title).toBe('我的项目')
  })
  it('orders workspaces by recent worker activity and leaves unknown activity last', () => {
    const rows = ['unknown-a', 'older', 'newer', 'unknown-b'].map(workspace)
    const merged = mergeWorkspaces(rows, [
      entry('unknown-a', 'dev-wsl', '/work/unknown-a'),
      entry('older', 'dev-wsl', '/work/older', 100),
      entry('newer', 'dev-wsl', '/work/newer', 300),
      entry('unknown-b', 'dev-wsl', '/work/unknown-b'),
    ])
    expect(merged.map(row => row.workspaceId)).toEqual(['newer', 'older', 'unknown-a', 'unknown-b'])
  })
  it('uses the newest activity when presentation workspaces merge', () => {
    const rows = ['first', 'second', 'other'].map(workspace)
    const merged = mergeWorkspaces(rows, [entry('first', 'dev-wsl', '/work/shared', 10), entry('second', 'dev-wsl', '/work/shared', 500), entry('other', 'dev-wsl', '/work/other', 100)])
    expect(merged.map(row => row.workspaceId)).toEqual(['first', 'other'])
    expect(merged[0]?.sessionIds).toEqual(['first', 'second'])
  })
  it('uses the first real user prompt, recovers backfilled prompts and preserves useful titles', () => {
    const user = (text: string): NativeEvent => ({ type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    expect(promptTitle({ sessionId: '123', title: 'Bridge · 123' }, [user('调研\n模型部署')])).toBe('调研 模型部署')
    expect(promptTitle({ title: '手动命名' }, [user('hello')])).toBe('手动命名')
    expect(promptTitle({}, [user('继续'), user('【恢复的首条用户消息】\n最初的任务')])).toBe('最初的任务')
    expect(promptTitle({}, [user('中'.repeat(100))])).toHaveLength(65)
  })
})
