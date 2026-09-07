import type { Snapshot } from './types.js'

export const mockSnapshot: Snapshot = {
  workers: [
    {
      id: 'codex@hal', machineId: 'hal', name: 'Codex @ HAL', status: 'online',
      platform: 'linux', hostname: 'hal.local',
      capabilities: ['codex-app-server', 'turn-steer', 'structured-input'],
      workspaces: ['/work/agent-bridge', '/work/dsh-plugin'], lastSeenAt: 1788770000000,
      bridgeVersion: '0.5.0', activeSessionCount: 2,
    },
    {
      id: 'agent@offline-box', machineId: 'offline-box', name: 'Agent @ Offline Box', status: 'offline',
      capabilities: [], workspaces: [], lastSeenAt: 1788760000000,
    },
  ],
  sessions: [
    { id: 'thr_active', workerId: 'codex@hal', agentType: 'codex', title: 'Bridge API', status: 'active', workspace: '/work/agent-bridge', activeTurnId: 'turn_44', lastActivityAt: 1788770000000, taskId: 't_bridge' },
    { id: 'thr_approval', workerId: 'codex@hal', agentType: 'codex', title: 'Release check', status: 'waiting_for_approval', workspace: '/work/dsh-plugin', activeTurnId: 'turn_45', lastActivityAt: 1788769900000 },
    { id: 'thr_idle', workerId: 'agent@offline-box', agentType: 'future-agent', title: 'Offline fixture', status: 'offline', workspace: '/work/example', activeTurnId: null, lastActivityAt: 1788760000000 },
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
