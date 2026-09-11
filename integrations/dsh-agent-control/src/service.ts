import { BridgeClient, type BridgeConfig } from './bridge-client.js'
import { ControlError } from './errors.js'
import { KanbanClient, type KanbanConfig } from './kanban-client.js'
import type { BridgeCall, DashboardRequest, JsonValue, KanbanCall } from './types.js'
import type { AgentBridgeImportTarget } from './agent-bridge-provider/import-target.js'

export interface AgentControlConfig { bridge: BridgeConfig; kanban: KanbanConfig }

const BRIDGE_OPERATIONS = new Set<BridgeCall['operation']>([
  'workers', 'delete_worker', 'models', 'snapshot', 'sessions', 'session', 'delete_session', 'session_events', 'create_session', 'submit_turn',
  'interrupt_turn', 'approvals', 'approval', 'resolve_approval', 'user_input', 'user_input_request',
  'respond_user_input', 'action', 'upload', 'download',
])
const KANBAN_OPERATIONS = new Set<KanbanCall['operation']>([
  'list', 'show', 'create', 'comment', 'link', 'request_review', 'request_changes', 'unblock',
  'reassign', 'reclaim', 'assignees',
])

export class AgentControlService {
  readonly bridge: BridgeClient
  readonly kanban: KanbanClient
  /** Phase 2: native DSH-session importer; bound by the agent-bridge provider. */
  importTarget: AgentBridgeImportTarget | undefined
  constructor(readonly config: AgentControlConfig) { this.bridge = new BridgeClient(config.bridge); this.kanban = new KanbanClient(config.kanban) }
  dispose(): void { this.kanban.dispose() }

  async dispatch(request: DashboardRequest, signal?: AbortSignal): Promise<JsonValue> {
    const args = request.args ?? {}
    if (request.domain === 'bridge') {
      if (request.operation === 'provider_status') return { registered: !!this.importTarget, ...(this.importTarget?.status() ?? {}) }
      if (request.operation === 'native_catalog') return this.importTarget?.catalog() ?? { sessions: [] }
      if (request.operation === 'delete_native') {
        if (!this.importTarget || typeof args['nativeId'] !== 'string') throw new ControlError('invalid_parameter', 'nativeId is required.', 400)
        return this.importTarget.deleteNative(args['nativeId'], signal)
      }
      if (request.operation === 'creation_sources' || request.operation === 'create_native') {
        if (!this.importTarget) throw new ControlError('invalid_operation', 'Bridge provider is not ready.', 400)
        if (typeof args['cwd'] !== 'string' || !args['cwd']) throw new ControlError('invalid_parameter', 'cwd is required.', 400)
        if (request.operation === 'creation_sources') return this.importTarget.creationSources(args['cwd'])
        if (typeof args['sourceId'] !== 'string') throw new ControlError('invalid_parameter', 'sourceId is required.', 400)
        const agent = await this.importTarget.createInWorkspace(args['cwd'], args['sourceId'], signal)
        return { nativeSessionId: String(agent.id) }
      }
      if (request.operation === 'import') {
        if (!this.importTarget) throw new ControlError('invalid_operation', 'AgentBridge import target is not registered.', 400)
        const sessionId = args['sessionId']
        if (typeof sessionId !== 'string' || !sessionId) throw new ControlError('invalid_parameter', 'sessionId is required.', 400)
        const agent = await this.importTarget.open(sessionId)
        return { nativeSessionId: typeof agent.id === 'string' ? agent.id : sessionId }
      }
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
      return { bridge: bridge as unknown as JsonValue, board, counts, sessionProvider: { registered: !!this.importTarget, ...(this.importTarget?.status() ?? {}) },
        needsAttention: bridge.approvals.length + bridge.userInput.length + (counts['error'] ?? 0) }
    }
    throw new ControlError('invalid_operation', 'Unknown overview operation.', 400)
  }
}
