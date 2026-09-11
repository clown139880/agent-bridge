import { describe, expect, it } from 'vitest'
import { mergeWorkspaces, type NativeEntry, type WorkspaceRow } from '../src/client/native-catalog.js'
import { promptTitle } from '../src/agent-bridge-provider/import-target.js'
import type { NativeEvent } from '../src/agent-bridge-provider/dsh-compat.js'

const entry = (nativeId: string, machineId = 'dev-wsl', workspace = '/work/agent-bridge'): NativeEntry => ({ nativeId, machineId, workspace, sessionId: nativeId, title: 'test', status: 'idle', worker: 'worker' })
const workspace = (id: string): WorkspaceRow => ({ workspaceId: id, path: '/presentation/' + id, title: 'agent-bridge · Codex @ dev-wsl', sessionIds: [id], createdAt: '2026-01-01', updatedAt: '2026-01-01' })
describe('native catalog', () => {
  it('merges only equal machine and actual path, preserving original identities and source snapshots', () => {
    const rows = ['codex', 'claude', 'hal', 'different', 'local'].map(workspace)
    const merged = mergeWorkspaces(rows, [entry('codex'), entry('claude'), entry('hal', 'hal'), entry('different', 'dev-wsl', '/other/agent-bridge')])
    expect(merged).toHaveLength(4)
    expect(merged[0]?.sessionIds).toEqual(['codex', 'claude'])
    expect(merged[0]?.title).toBe('agent-bridge @ dev-wsl')
    expect(rows[0]?.sessionIds).toEqual(['codex'])
    expect(merged.at(-1)).toBe(rows.at(-1))
  })
  it('preserves custom group titles', () => {
    expect(mergeWorkspaces([{ ...workspace('a'), title: '我的项目' }], [entry('a')])[0]?.title).toBe('我的项目')
  })
  it('uses the first real user prompt, recovers backfilled prompts and preserves useful titles', () => {
    const user = (text: string): NativeEvent => ({ type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    expect(promptTitle({ sessionId: '123', title: 'Bridge · 123' }, [user('调研\n模型部署')])).toBe('调研 模型部署')
    expect(promptTitle({ title: '手动命名' }, [user('hello')])).toBe('手动命名')
    expect(promptTitle({}, [user('继续'), user('【恢复的首条用户消息】\n最初的任务')])).toBe('最初的任务')
    expect(promptTitle({}, [user('中'.repeat(100))])).toHaveLength(65)
  })
})
