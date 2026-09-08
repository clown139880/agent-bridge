import type { BridgeCall, JsonObject, JsonValue } from '../types.js'
import { asRecord, mergeRecords, readPage, requiredId, str } from './session-model.js'

export type BridgeRpc = (operation: BridgeCall['operation'], args?: JsonObject) => Promise<JsonValue>
export interface SessionDetail {
  session?: JsonObject
  events: JsonObject[]
  approvals: JsonObject[]
  inputs: JsonObject[]
  cursor: string | null
  hasMore: boolean
  loaded: boolean
  loading: boolean
  eventsLoading: boolean
  error: string
  eventsError: string
  draft: string
  model: string
  busy: boolean
  notice: string
  action?: JsonObject
}
export interface SessionState {
  workers?: JsonObject[]
  workersError?: string
  creation?: { workerId: string; workspace: string; busy: boolean; notice: string; action?: JsonObject; origin?: string | undefined }
  sessions: JsonObject[]
  selected: string | undefined
  cursor: string | null
  hasMore: boolean
  loading: boolean
  loaded: boolean
  error: string
  details: Record<string, SessionDetail>
  modelCatalogs: Record<string, { catalog?: JsonObject; models: JsonObject[]; loading: boolean; error: string }>
}
const emptyDetail = (): SessionDetail => ({ events: [], approvals: [], inputs: [], cursor: null, hasMore: false, loaded: false, loading: false, eventsLoading: false, error: '', eventsError: '', draft: '', model: '', busy: false, notice: '' })
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Bridge request failed.'

/** One configured Bridge connection. Immutable UI snapshots; async writes always target their captured session. */
export class SessionStore {
  private state: SessionState = { sessions: [], selected: undefined, cursor: null, hasMore: false, loading: false, loaded: false, error: '', details: {}, modelCatalogs: {} }
  private listeners = new Set<() => void>()
  private generation = 0
  private active = true
  private historyLoaded = false
  constructor(private readonly rpc: BridgeRpc, private readonly loadNativeModelCatalog?: () => Promise<JsonValue>) {}
  private workersLoading = false
  async loadWorkers(): Promise<void> {
    if (this.workersLoading) return
    this.workersLoading = true
    try {
      const value = asRecord(await this.rpc('workers'))
      if (!Array.isArray(value['workers'])) throw new Error('Invalid worker list.')
      this.patch({ workers: value['workers'].map(asRecord), workersError: '' })
    } catch (error) { this.patch({ workers: [], workersError: errorText(error) }) }
    finally { this.workersLoading = false }
  }
  canCreate(workerId: string): boolean {
    const worker = this.state.workers?.find(row => row['id'] === workerId)
    return worker?.['status'] === 'online' && Array.isArray(worker['capabilities']) && worker['capabilities'].includes('session-actions')
  }
  async createSession(workerId: string, workspace: string): Promise<void> {
    if (this.state.creation?.busy || this.state.creation?.action?.['status'] === 'accepted' || !workspace.trim() || !this.canCreate(workerId)) return
    this.patch({ creation: { workerId, workspace, busy: true, notice: 'Creating conversation…', origin: this.state.selected } })
    try {
      await this.loadWorkers()
      if (!this.canCreate(workerId)) throw new Error('Worker is offline or session creation is unavailable.')
      const action = asRecord(await this.rpc('create_session', { workerId, workspace }))
      requiredId(action, 'actionId')
      await this.settleCreation(action)
    } catch (error) { this.patch({ creation: { ...this.state.creation!, notice: errorText(error) } }) }
    finally { this.patch({ creation: { ...this.state.creation!, busy: false } }) }
  }
  private async settleCreation(action: JsonObject): Promise<void> {
    const previous = this.state.creation!
    const status = action['status']
    if (!['accepted', 'succeeded', 'failed'].includes(str(status))) throw new Error('Unexpected creation receipt.')
    this.patch({ creation: { ...previous, action, notice: status === 'failed' ? `Creation failed: ${str(asRecord(action['error'])['message'])}` : status === 'accepted' ? 'Creation accepted. Waiting for worker…' : 'Conversation created.' } })
    if (status === 'succeeded') {
      const id = requiredId(action, 'sessionId')
      if (this.active) {
        await this.loadSessions()
        if (this.state.selected === previous.origin) this.select(id)
      }
    }
  }
  private checkingCreation = false
  async checkCreation(): Promise<void> {
    const previous = this.state.creation
    if (previous?.action?.['status'] !== 'accepted' || this.checkingCreation) return
    this.checkingCreation = true
    try {
      const action = asRecord(await this.rpc('action', { actionId: requiredId(previous.action, 'actionId') }))
      if (requiredId(action, 'actionId') !== previous.action['actionId']) throw new Error('Unexpected creation receipt.')
      await this.settleCreation(action)
    } catch (error) { this.patch({ creation: { ...this.state.creation!, notice: `Creation outcome unconfirmed: ${errorText(error)}` } }) }
    finally { this.checkingCreation = false }
  }
  snapshot = (): SessionState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  activate(): void { this.active = true }
  dispose(): void {
    this.active = false; this.generation++
    this.state = { ...this.state, loading: false, details: Object.fromEntries(Object.entries(this.state.details).map(([id, detail]) => [id, { ...detail, loading: false, eventsLoading: false }])) }
  }
  private valid(generation: number): boolean { return this.active && generation === this.generation }
  private patch(patch: Partial<SessionState>): void { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener() }
  private detail(id: string): SessionDetail { return this.state.details[id] ?? emptyDetail() }
  private patchDetail(id: string, patch: Partial<SessionDetail>): void { this.patch({ details: { ...this.state.details, [id]: { ...this.detail(id), ...patch } } }) }
  select(id: string): void {
    this.patch({ selected: id })
    if (!this.state.details[id]) this.patchDetail(id, {})
    void this.refreshDetail(id)
    if (!this.detail(id).loaded) void this.loadEvents(id)
  }
  setDraft(id: string, draft: string): void { this.patchDetail(id, { draft }) }
  setModel(id: string, model: string): void { this.patchDetail(id, { model }) }
  invalidateModels(): void { this.patch({ modelCatalogs: {} }) }
  async loadModels(workerId: string): Promise<void> {
    if (this.state.modelCatalogs[workerId]?.loading) return
    this.patch({ modelCatalogs: { ...this.state.modelCatalogs, [workerId]: { models: this.state.modelCatalogs[workerId]?.models ?? [], loading: true, error: '' } } })
    try {
      if (!this.loadNativeModelCatalog) throw new Error('The DSH provider model catalog is unavailable.')
      const existing = Object.values(this.state.modelCatalogs).find(entry => entry.catalog)?.catalog
      const catalog = existing ?? asRecord(await this.loadNativeModelCatalog())
      if (!Array.isArray(catalog['groups']) || !catalog['default'] || typeof catalog['default'] !== 'object') throw new Error('DSH returned an invalid model catalog.')
      this.patch({ modelCatalogs: { ...this.state.modelCatalogs, [workerId]: { catalog, models: [], loading: false, error: '' } } })
    } catch (error) {
      this.patch({ modelCatalogs: { ...this.state.modelCatalogs, [workerId]: { models: this.state.modelCatalogs[workerId]?.models ?? [], loading: false, error: errorText(error) } } })
    }
  }

  async loadSessions(more = false): Promise<void> {
    if (this.state.loading || (more && !this.state.hasMore)) return
    const generation = this.generation
    const dayStart = new Date().setHours(0, 0, 0, 0)
    let cursor = more ? this.state.cursor : null
    let rows: JsonObject[] = more ? this.state.sessions : []
    const seen = new Set<string>()
    this.patch({ loading: true, error: '' })
    try {
      if (!more) rows = []
      do {
        const page = readPage(await this.rpc('sessions', {
          segment: more ? 'history' : 'recent', dayStart, sort: 'updatedAt', order: 'desc', limit: 200,
          ...(cursor ? { cursor } : {}),
        }), 'sessionId')
        if (!this.valid(generation)) return
        if (page.hasMore && (page.cursor === cursor || seen.has(page.cursor!))) throw new Error('Session pagination did not advance. Refresh to retry.')
        if (page.cursor) seen.add(page.cursor)
        rows = mergeRecords(rows, page.data, 'sessionId'); cursor = page.cursor
        if (more) {
          this.historyLoaded = true
          this.patch({ sessions: rows, cursor, hasMore: page.hasMore, loaded: true })
        }
        if (!this.state.selected && rows[0]) this.patch({ selected: requiredId(rows[0], 'sessionId') })
        if (more || !page.hasMore) break
      } while (this.valid(generation))
      if (!more && this.valid(generation)) {
        const attention = new Set(['creating', 'active', 'waiting_for_approval', 'waiting_for_input', 'error'])
        const retainedHistory = this.state.sessions.filter(row => {
          const updated = typeof row['updatedAt'] === 'number' ? row['updatedAt'] : 0
          return updated < dayStart && !attention.has(str(row['status']))
        })
        this.patch({ sessions: mergeRecords(rows, retainedHistory, 'sessionId'), cursor: this.state.cursor,
          hasMore: this.historyLoaded ? this.state.hasMore : true, loaded: true })
      }
    } catch (error) { if (this.valid(generation)) this.patch({ error: errorText(error) }) }
    finally { if (this.valid(generation)) this.patch({ loading: false }) }
  }

  private async pending(operation: 'approvals' | 'user_input', id: string): Promise<JsonObject[]> {
    let cursor: string | null = null
    let rows: JsonObject[] = []
    const seen = new Set<string>()
    const generation = this.generation
    do {
      const page = readPage(await this.rpc(operation, { sessionId: id, status: 'pending', limit: 100, ...(cursor ? { cursor } : {}) }), 'id')
      if (!this.valid(generation)) return []
      rows = mergeRecords(rows, page.data.filter(row => row['sessionId'] === id && row['status'] === 'pending'), 'id')
      if (!page.hasMore) return rows
      if (!page.cursor || seen.has(page.cursor)) throw new Error('Pending request pagination did not advance.')
      seen.add(page.cursor); cursor = page.cursor
    } while (this.valid(generation))
    return rows
  }
  async refreshDetail(id: string): Promise<void> {
    if (this.detail(id).loading) return
    const generation = this.generation
    this.patchDetail(id, { loading: true, error: '' })
    try {
      const [raw, approvals, inputs] = await Promise.all([this.rpc('session', { sessionId: id }), this.pending('approvals', id), this.pending('user_input', id)])
      if (!this.valid(generation)) return
      const session = asRecord(raw)
      if (requiredId(session, 'sessionId') !== id) throw new Error('Bridge returned a different session.')
      this.patchDetail(id, { session, approvals, inputs })
      this.patch({ sessions: this.state.sessions.map(row => row['sessionId'] === id ? session : row) })
    } catch (error) { if (this.valid(generation)) this.patchDetail(id, { error: errorText(error) }) }
    finally { if (this.valid(generation)) this.patchDetail(id, { loading: false }) }
  }
  async loadEvents(id: string, reset = false): Promise<void> {
    const detail = this.detail(id)
    if (detail.eventsLoading) return
    const generation = this.generation
    const before = reset ? null : detail.cursor
    this.patchDetail(id, { eventsLoading: true, eventsError: '' })
    try {
      const page = readPage(await this.rpc('session_events', { sessionId: id, limit: 200, tail: true, ...(before ? { before } : {}) }), 'eventId')
      if (!this.valid(generation)) return
      if (page.data.some(event => event['sessionId'] !== id)) throw new Error('Bridge returned events for a different session.')
      if (page.hasMore && page.cursor === before) throw new Error('Event pagination did not advance. Reload available history.')
      this.patchDetail(id, { events: reset ? page.data : mergeRecords(page.data, detail.events, 'eventId'), cursor: page.cursor, hasMore: page.hasMore, loaded: true })
    } catch (error) { if (this.valid(generation)) this.patchDetail(id, { eventsError: errorText(error) }) }
    finally { if (this.valid(generation)) this.patchDetail(id, { eventsLoading: false }) }
  }
  async refreshLatestEvents(id: string): Promise<void> {
    const detail = this.detail(id)
    if (detail.eventsLoading || !detail.loaded) return this.loadEvents(id)
    const generation = this.generation
    this.patchDetail(id, { eventsLoading: true, eventsError: '' })
    try {
      const page = readPage(await this.rpc('session_events', { sessionId: id, limit: 200, tail: true }), 'eventId')
      if (!this.valid(generation)) return
      if (page.data.some(event => event['sessionId'] !== id)) throw new Error('Bridge returned events for a different session.')
      this.patchDetail(id, { events: mergeRecords(detail.events, page.data, 'eventId'), loaded: true })
    } catch (error) { if (this.valid(generation)) this.patchDetail(id, { eventsError: errorText(error) }) }
    finally { if (this.valid(generation)) this.patchDetail(id, { eventsLoading: false }) }
  }
  async refresh(): Promise<void> {
    const id = this.state.selected
    await Promise.all([this.loadSessions(), ...(id ? [this.refreshDetail(id), this.refreshLatestEvents(id), this.checkAction(id)] : [])])
  }

  async deleteSession(id: string): Promise<boolean> {
    const detail = this.detail(id)
    if (detail.busy || detail.action?.['status'] === 'accepted') return false
    this.patchDetail(id, { busy: true, notice: '' })
    try {
      const action = asRecord(await this.rpc('delete_session', { sessionId: id }))
      requiredId(action, 'actionId')
      if (action['kind'] !== 'delete_session' || action['sessionId'] !== id) throw new Error('Bridge returned an invalid deletion receipt.')
      this.patchDetail(id, { action, notice: action['status'] === 'accepted' ? 'Deletion accepted. Waiting for Codex…' : '' })
      this.settle(id, action)
      return action['status'] === 'succeeded'
    } catch (error) {
      this.patchDetail(id, { notice: errorText(error) })
      return false
    } finally {
      if (this.state.details[id]) this.patchDetail(id, { busy: false })
    }
  }

  async act(id: string, operation: 'submit_turn' | 'interrupt_turn' | 'resolve_approval' | 'respond_user_input', args: JsonObject = {}): Promise<void> {
    const detail = this.detail(id)
    if (detail.busy || detail.action?.['status'] === 'accepted') return
    const input = detail.draft.trim()
    if (operation === 'submit_turn' && !input) return
    if (!detail.session || detail.error) { this.patchDetail(id, { notice: 'Session information is unavailable. Refresh and try again.' }); return }
    if (detail.session['status'] === 'offline' || !Array.isArray(detail.session['capabilities']) || !detail.session['capabilities'].includes('session-actions')) return
    const turn = detail.session['activeTurnId']
    if (operation === 'interrupt_turn' && typeof turn !== 'string') return
    const model = detail.model.trim()
    const payload = operation === 'submit_turn' ? { sessionId: id, input, delivery: 'auto', ...(typeof turn === 'string' ? { expectedTurnId: turn } : model ? { model } : {}) }
      : operation === 'interrupt_turn' ? { sessionId: id, ...(typeof turn === 'string' ? { expectedTurnId: turn } : {}) } : args
    this.patchDetail(id, { busy: true, notice: '' })
    try {
      const action = asRecord(await this.rpc(operation, payload))
      requiredId(action, 'actionId')
      this.patchDetail(id, { action, notice: `Action ${str(action['status'])} · ${str(action['actionId'])}` })
      // Keep the submitted text until the action is confirmed. A failed asynchronous receipt remains retryable.
      if (operation === 'submit_turn') this.submitted.set(id, { actionId: requiredId(action, 'actionId'), draft: detail.draft })
      this.settle(id, action)
      if (this.active) { await this.refreshDetail(id); await this.refreshLatestEvents(id) }
    } catch (error) {
      this.patchDetail(id, { notice: errorText(error) })
      if (this.active) await this.refreshDetail(id)
    } finally { this.patchDetail(id, { busy: false }) }
  }
  private submitted = new Map<string, { actionId: string; draft: string }>()
  private checking = new Set<string>()
  private removeSession(id: string): void {
    const sessions = this.state.sessions.filter(row => row['sessionId'] !== id)
    const details = { ...this.state.details }; delete details[id]
    const deletedIndex = this.state.sessions.findIndex(row => row['sessionId'] === id)
    const next = sessions[Math.min(Math.max(deletedIndex, 0), sessions.length - 1)]
    this.patch({ sessions, details, selected: this.state.selected === id && next ? requiredId(next, 'sessionId') : this.state.selected === id ? undefined : this.state.selected })
  }
  private settle(id: string, action: JsonObject): void {
    const status = action['status']
    if (action['kind'] === 'delete_session') {
      if (status === 'succeeded') this.removeSession(id)
      else if (status === 'failed') this.patchDetail(id, { notice: `Deletion failed: ${str(asRecord(action['error'])['message'], 'Unknown error')}` })
      return
    }
    const sent = this.submitted.get(id)
    if (status === 'succeeded' && sent && sent.actionId === action['actionId']) {
      if (this.detail(id).draft === sent.draft) this.patchDetail(id, { draft: '' })
      this.submitted.delete(id)
    }
    if (status === 'failed') this.patchDetail(id, { notice: `Action failed: ${str(asRecord(action['error'])['message'], 'Unknown error')}` })
  }
  async checkAction(id: string): Promise<void> {
    const previous = this.detail(id).action
    if (previous?.['status'] !== 'accepted' || this.checking.has(id)) return
    const generation = this.generation
    this.checking.add(id)
    try {
      const action = asRecord(await this.rpc('action', { actionId: requiredId(previous, 'actionId') }))
      if (!this.valid(generation)) return
      if (requiredId(action, 'actionId') !== previous['actionId']) throw new Error('Unexpected action receipt.')
      this.patchDetail(id, { action, notice: `Action ${str(action['status'])} · ${str(action['actionId'])}` })
      this.settle(id, action)
      if (action['status'] !== 'accepted' && this.state.sessions.some(row => row['sessionId'] === id)) { await this.refreshDetail(id); await this.refreshLatestEvents(id) }
    } catch (error) { if (this.valid(generation)) this.patchDetail(id, { notice: `Action outcome unconfirmed: ${errorText(error)}. Refresh to check again.` }) }
    finally { this.checking.delete(id) }
  }
}
