import type { JsonObject, Snapshot } from './types.js'

export const mockSnapshot: Snapshot = {
  workers: [
    {
      id: 'codex@hal', machineId: 'hal', name: 'Codex @ HAL', status: 'online',
      platform: 'linux', hostname: 'hal.local',
      capabilities: ['codex-app-server', 'session-actions', 'turn-steer', 'structured-input'],
      workspaces: ['/work/agent-bridge', '/work/dsh-plugin'], lastSeenAt: 1788770000000,
      bridgeVersion: '0.5.0', activeSessionCount: 2,
    },
    {
      id: 'agent@offline-box', machineId: 'offline-box', name: 'Agent @ Offline Box', status: 'offline',
      capabilities: [], workspaces: [], lastSeenAt: 1788760000000,
    },
  ],
  sessions: [
    { sessionId: 'thr_active', workerId: 'codex@hal', agentType: 'codex', title: 'Bridge API', status: 'active', workspace: '/work/agent-bridge', activeTurnId: 'turn_44', updatedAt: 1788770000000, taskId: 't_bridge' },
    { sessionId: 'thr_approval', workerId: 'codex@hal', agentType: 'codex', title: 'Release check', status: 'waiting_for_approval', workspace: '/work/dsh-plugin', activeTurnId: 'turn_45', updatedAt: 1788769900000 },
    { sessionId: 'thr_idle', workerId: 'agent@offline-box', agentType: 'future-agent', title: 'Offline fixture', status: 'offline', workspace: '/work/example', activeTurnId: null, updatedAt: 1788760000000 },
  ],
  approvals: [{ id: 'ap_9', sessionId: 'thr_approval', status: 'pending', kind: 'command', summary: 'pnpm test', choices: ['allow', 'deny'] }],
  userInput: [],
  streamCursor: 'mock:1',
  truncated: { sessions: false },
}

export const mockBoard = {
  columns: [
    { name: 'triage', tasks: [] },
    { name: 'todo', tasks: [{ id: 't_plan', title: 'Plan integration', status: 'todo', assignee: 'codex@hal', priority: 2 }] },
    { name: 'ready', tasks: [] },
    { name: 'running', tasks: [{ id: 't_bridge', title: 'Implement Bridge API', status: 'running', assignee: 'codex@hal', priority: 3, workspace_path: '/work/agent-bridge' }] },
    { name: 'blocked', tasks: [] },
    { name: 'review', tasks: [] },
    { name: 'done', tasks: [] },
  ],
  assignees: ['codex@hal'],
  latest_event_id: 1,
}

/** Real wire envelopes, including a second history page and a late item after a turn terminal. */
export const mockSessionEvents: JsonObject[] = [
  { eventId: 'mock-context', sessionId: 'thr_active', turnId: 'turn_44', type: 'context.updated', timestamp: 1788770000450, payload: { usedTokens: 48217, contextWindow: 128000, inputTokens: 45112, outputTokens: 3105, reasoningTokens: 1840 } },
  { eventId: 'mock-user', sessionId: 'thr_active', turnId: 'turn_43', itemId: 'user_1', type: 'message.completed', timestamp: 1788770000000, payload: { role: 'user', text: '检查分页和会话展示。保留命令输出，告诉我验证结果。' } },
  { eventId: 'mock-assistant', sessionId: 'thr_active', turnId: 'turn_43', itemId: 'assistant_1', type: 'message.completed', timestamp: 1788770000100, payload: { role: 'assistant', text: '### 验证结果\n\n分页已经接通，下面是执行记录。\n\n- 会话按工作空间分组\n- **保留原始事件**，方便核对\n\n```ts\nconst next = await loadPage(cursor)\n```\n\n| 检查 | 结果 |\n| --- | --- |\n| 标题与路径 | 通过 |\n| 历史分页 | 通过 |' } },
  { eventId: 'mock-terminal', sessionId: 'thr_active', turnId: 'turn_43', type: 'turn.completed', timestamp: 1788770000200, payload: { status: 'completed' } },
  { eventId: 'mock-command', sessionId: 'thr_active', turnId: 'turn_43', itemId: 'command_1', type: 'command.completed', timestamp: 1788770000300, payload: { command: 'pnpm test', cwd: '/work/agent-bridge', status: 'completed', exitCode: 0, output: '✓ pagination\n✓ session isolation\n✓ action receipts\n\n3 tests passed' } },
  { eventId: 'mock-files', sessionId: 'thr_active', turnId: 'turn_43', itemId: 'files_1', type: 'file_change.completed', timestamp: 1788770000400, payload: { changes: [{ path: 'src/session-store.ts', diff: '- const limit = 100\n+ await loadNextPage(cursor)' }] } },
  ...Array.from({ length: 196 }, (_, index): JsonObject => ({ eventId: `mock-progress-${index}`, sessionId: 'thr_active', turnId: 'turn_44', type: 'progress', timestamp: 1788770000500 + index, payload: { summary: `Pagination fixture ${index + 1} / 196` } })),
  { eventId: 'mock-future', sessionId: 'thr_active', turnId: 'turn_44', type: 'future.event', timestamp: 1788770000900, payload: { note: 'Unknown events remain inspectable.' } },
].map((event, index) => ({ runId: null, itemId: null, ...event, cursor: `mock:${index + 1}` }))
