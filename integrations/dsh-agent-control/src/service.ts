import { randomUUID } from 'node:crypto'
import { BridgeClient, type BridgeConfig } from './bridge-client.js'
import { ControlError } from './errors.js'
import type { BridgeCall, DashboardRequest, JsonValue, JsonObject } from './types.js'
import type { AgentBridgeImportTarget } from './agent-bridge-provider/import-target.js'
import { ProviderModelCatalog } from './provider-models.js'
import { RemoteSessionLogs, virtualSessionId } from './remote-sessions/log.js'
import { record, str } from './agent-bridge-provider/mapping.js'

export interface AgentControlConfig { bridge: BridgeConfig }

const BRIDGE_OPERATIONS = new Set<BridgeCall['operation']>([
  'workers', 'delete_worker', 'models', 'snapshot', 'sessions', 'session', 'delete_session', 'session_events', 'create_session', 'submit_turn',
  'interrupt_turn', 'approvals', 'approval', 'resolve_approval', 'user_input', 'user_input_request',
  'respond_user_input', 'action', 'upload', 'download',
])

export class AgentControlService {
  readonly bridge: BridgeClient
  /** Phase 2: native DSH-session importer; bound by the agent-bridge provider. */
  importTarget: AgentBridgeImportTarget | undefined
  readonly providerModels: ProviderModelCatalog
  readonly remoteLogs: RemoteSessionLogs
  constructor(readonly config: AgentControlConfig, providerModels = new ProviderModelCatalog()) {
    this.bridge = new BridgeClient(config.bridge)
    this.providerModels = providerModels
    this.remoteLogs = new RemoteSessionLogs(this.bridge, config.bridge.origin)
  }
  dispose(): void {}

  async dispatch(request: DashboardRequest, signal?: AbortSignal): Promise<JsonValue> {
    const args = request.args ?? {}
    if (request.domain === 'bridge') {
      if (request.operation === 'virtual_catalog') return this.catalogChanges(Number(args['since']) || 0, str(args['epoch']))
      if (request.operation.startsWith('virtual_')) {
        const id = str(args['id'])
        if (request.operation === 'virtual_open') return this.remoteLogs.open(id, this.virtualEntries(), signal)
        if (request.operation === 'virtual_poll') return this.remoteLogs.poll(id, str(args['epoch']), Number(args['after']), signal)
        if (request.operation === 'virtual_page') return this.remoteLogs.page(id, str(args['epoch']), args)
        throw new Error('Unknown virtual session operation')
      }
      if (request.operation === 'provider_status') return { registered: !!this.importTarget, ...(this.importTarget?.status() ?? {}) }
      if (request.operation === 'provider_models') {
        if (args['refresh'] === true || args['refresh'] === 'true') this.providerModels.invalidate()
        const models = await this.providerModels.models(signal)
        return { models: models.map(model => ({ id: model.id, name: model.name, endpoints: [...model.endpoints] })) }
      }
      if (request.operation === 'native_catalog') return this.importTarget?.catalog() ?? { sessions: [] }
      if (request.operation === 'delete_native') {
        if (!this.importTarget || typeof args['nativeId'] !== 'string') throw new ControlError('invalid_parameter', 'nativeId is required.', 400)
        return this.importTarget.deleteNative(args['nativeId'], signal)
      }
      if (request.operation === 'delete_native_workspace') {
        if (!this.importTarget || !Array.isArray(args['nativeIds']) || !args['nativeIds'].every(id => typeof id === 'string')) {
          throw new ControlError('invalid_parameter', 'nativeIds is required.', 400)
        }
        return this.importTarget.deleteNativeWorkspace(args['nativeIds'], signal)
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
    if (request.domain === 'overview' && request.operation === 'snapshot') {
      const bridge = await this.bridge.snapshot(signal)
      const counts: Record<string, number> = {}
      for (const session of bridge.sessions) counts[session.status] = (counts[session.status] ?? 0) + 1
      return { bridge: bridge as unknown as JsonValue, counts, sessionProvider: { registered: !!this.importTarget, ...(this.importTarget?.status() ?? {}) },
        needsAttention: bridge.approvals.length + bridge.userInput.length + (counts['error'] ?? 0) }
    }
    throw new ControlError('invalid_operation', 'Unknown overview operation.', 400)
  }
  /**
   * The catalog as changes since a revision: polled every few seconds by every
   * window, it would otherwise resend hundreds of unchanged sessions each time.
   * Per-entry revisions; a client from another epoch (Host restart) gets all.
   */
  private readonly catalog = { epoch: randomUUID(), rev: 0, entries: new Map<string, { json: string; rev: number }>(),
    removed: new Map<string, number>(), order: '', orderRev: 0 }
  private catalogChanges(since: number, epoch: string): JsonObject {
    const state = this.catalog, entries = this.virtualEntries(), seen = new Set<string>()
    for (const entry of entries) {
      const id = str(entry['nativeId']), json = JSON.stringify(entry)
      seen.add(id); state.removed.delete(id)
      if (state.entries.get(id)?.json !== json) state.entries.set(id, { json, rev: ++state.rev })
    }
    for (const id of [...state.entries.keys()]) if (!seen.has(id)) { state.entries.delete(id); state.removed.set(id, ++state.rev) }
    const order = entries.map(entry => str(entry['nativeId'])).join('\n')
    if (order !== state.order) { state.order = order; state.orderRev = ++state.rev }
    const full = epoch !== state.epoch || since > state.rev
    const after = full ? 0 : since
    return { epoch: state.epoch, rev: state.rev, full,
      sessions: [...state.entries.values()].filter(entry => entry.rev > after).map(entry => JSON.parse(entry.json) as JsonObject),
      removed: full ? [] : [...state.removed].filter(([, rev]) => rev > after).map(([id]) => id),
      ...(state.orderRev > after ? { order: entries.map(entry => str(entry['nativeId'])) } : {}) }
  }
  private virtualEntries(): JsonObject[] {
    const catalog = this.importTarget?.catalog()
    const entries = catalog?.['sessions']
    return Array.isArray(entries) ? entries.map(record).filter(row => str(row['sessionId'])).map(row => ({ ...row,
      importedId: row['nativeId'] ?? '', nativeId: virtualSessionId(this.config.bridge.origin, str(row['sessionId'])),
    })) : []
  }
}
