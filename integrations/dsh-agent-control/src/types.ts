export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type WorkerStatus = 'online' | 'offline' | (string & {})
export interface Worker {
  id: string
  machineId: string
  name: string
  status: WorkerStatus
  platform?: string
  hostname?: string
  capabilities: string[]
  workspaces: string[]
  recentWorkspaces?: Array<{ path: string; name?: string; lastUsedAt: number }>
  lastSeenAt: number
  bridgeVersion?: string
  activeSessionCount?: number
}

export type SessionStatus = 'creating' | 'active' | 'waiting_for_approval' | 'waiting_for_input' | 'idle' | 'offline' | 'error' | 'unknown' | (string & {})
export interface SessionSummary {
  sessionId: string
  workerId: string
  agentType?: string
  title?: string
  status: SessionStatus
  workspace: string
  activeTurnId?: string | null
  updatedAt: number
  createdAt?: number
  taskId?: string | null
  runId?: string | null
  [key: string]: JsonValue | undefined
}

export interface PendingRequest {
  id: string
  sessionId: string
  status: string
  kind?: string
  summary?: string
  choices?: string[]
  questions?: Array<{
    id: string
    header: string
    question: string
    isOther?: boolean
    isSecret?: boolean
    options?: Array<{ label: string; description?: string }>
  }>
  [key: string]: JsonValue | undefined
}

export interface Snapshot {
  workers: Worker[]
  sessions: SessionSummary[]
  approvals: PendingRequest[]
  userInput: PendingRequest[]
  streamCursor?: string
  truncated?: { sessions: boolean }
}

export interface Page<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
  streamCursor?: string
}

export interface ActionReceipt {
  actionId: string
  kind: string
  status: string
  sessionId: string | null
  turnId: string | null
  resolvedAction?: 'steer' | 'start_turn'
  error?: JsonValue
  createdAt?: number
  updatedAt?: number
}

export type BridgeStreamEventType = 'worker.upserted' | 'worker.offline' | 'session.upserted' | 'session.updated' |
  'session.deleted' | 'session.event.appended' | 'approval.upserted' | 'user_input.upserted' | 'action.updated'

export interface BridgeStreamEvent {
  cursor: string
  eventId: string
  type: BridgeStreamEventType
  timestamp: number
  resource: { kind: string; id: string }
  sessionId: string | null
  data: JsonValue
}

export interface BridgeCall {
  operation: 'workers' | 'delete_worker' | 'models' | 'snapshot' | 'sessions' | 'session' | 'delete_session' | 'session_events' | 'create_session' |
    'submit_turn' | 'interrupt_turn' | 'approvals' | 'approval' | 'resolve_approval' |
    'user_input' | 'user_input_request' | 'respond_user_input' | 'action' | 'upload' | 'download'
  args?: JsonObject
}

/** Image attachment reference returned by the control-plane upload endpoint. */
export interface AttachmentRef {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface KanbanCall {
  operation: 'list' | 'show' | 'create' | 'comment' | 'link' | 'request_review' |
    'request_changes' | 'unblock' | 'reassign' | 'reclaim' | 'assignees'
  args?: JsonObject
}

export interface DashboardRequest {
  domain: 'overview' | 'bridge' | 'kanban'
  operation: string
  args?: JsonObject
}

export interface DashboardResponse {
  ok: boolean
  data?: JsonValue
  error?: { code: string; message: string; status?: number; retryable?: boolean }
}
