import { BridgeClient, type BridgeConfig } from './bridge-client.js'
import { ControlError } from './errors.js'
import { KanbanClient, type KanbanConfig } from './kanban-client.js'
import type { BridgeCall, DashboardRequest, JsonValue, KanbanCall } from './types.js'

export interface AgentControlConfig { bridge: BridgeConfig; kanban: KanbanConfig }

const BRIDGE_OPERATIONS = new Set<BridgeCall['operation']>([
  'workers', 'snapshot', 'sessions', 'session', 'session_events', 'create_session', 'submit_turn',
  'interrupt_turn', 'approvals', 'approval', 'resolve_approval', 'user_input', 'user_input_request',
  'respond_user_input', 'action',
])
const KANBAN_OPERATIONS = new Set<KanbanCall['operation']>([
  'list', 'show', 'create', 'comment', 'link', 'request_review', 'request_changes', 'unblock',
  'reassign', 'reclaim', 'assignees',
])

export class AgentControlService {
  readonly bridge: BridgeClient
  readonly kanban: KanbanClient
  constructor(config: AgentControlConfig) { this.bridge = new BridgeClient(config.bridge); this.kanban = new KanbanClient(config.kanban) }
  dispose(): void { this.kanban.dispose() }

  async dispatch(request: DashboardRequest, signal?: AbortSignal): Promise<JsonValue> {
    const args = request.args ?? {}
    if (request.domain === 'bridge') {
      if (!BRIDGE_OPERATIONS.has(request.operation as BridgeCall['operation'])) throw new ControlError('invalid_operation', 'Unknown Bridge operation.', 400)
      return this.bridge.call({ operation: request.operation as BridgeCall['operation'], args }, signal)
    }
    if (request.domain === 'kanban') {
      if (!KANBAN_OPERATIONS.has(request.operation as KanbanCall['operation'])) throw new ControlError('invalid_operation', 'Unknown Kanban operation.', 400)
      return this.kanban.call({ operation: request.operation as KanbanCall['operation'], args }, signal)
    }
    if (request.domain === 'overview' && request.operation === 'snapshot') {
      const [bridge, board] = await Promise.all([this.bridge.snapshot(signal), this.kanban.call({ operation: 'list' }, signal)])
      const counts: Record<string, number> = {}
      for (const session of bridge.sessions) counts[session.status] = (counts[session.status] ?? 0) + 1
      return { bridge: bridge as unknown as JsonValue, board, counts,
        needsAttention: bridge.approvals.length + bridge.userInput.length + (counts['error'] ?? 0) }
    }
    throw new ControlError('invalid_operation', 'Unknown overview operation.', 400)
  }
}
