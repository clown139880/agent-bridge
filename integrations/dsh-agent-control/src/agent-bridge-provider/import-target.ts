import { createHash } from 'node:crypto'
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, basename, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeClient } from '../bridge-client.js'
import type { JsonObject } from '../types.js'
import { appendSessionEvent, guardImportedTurnNumbers, nativeSession, sessionEvents, type NativeHost, type NativeHandle, type NativeEvent } from './dsh-compat.js'
import { ACK_EVENT, BINDING_EVENT, PROVIDER, projectNativeEvents, record, str } from './mapping.js'
import { relayPendingInteractions } from './approval-bridge.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
export function nativeSessionId(origin: string, sessionId: string): string {
  return 'agent-bridge-' + hash(new URL(origin).origin + '\0' + sessionId)
}
export async function readHistory(bridge: Pick<BridgeClient, 'call'>, sessionId: string, after?: string, signal?: AbortSignal): Promise<{ rows: JsonObject[]; cursor?: string }> {
  const rows: JsonObject[] = []
  const cursors = new Set<string>()
  let cursor = after
  do {
    signal?.throwIfAborted()
    const page = record(await bridge.call({ operation: 'session_events', args: { sessionId, limit: 200, ...(cursor ? { after: cursor } : {}) } }, signal))
    if (!Array.isArray(page['data'])) throw new Error('Invalid Bridge history page')
    for (const value of page['data']) {
      const row = record(value)
      if (row['sessionId'] !== sessionId || !str(row['eventId'])) throw new Error('Bridge returned cross-session or unidentified history')
      rows.push(row)
    }
    const next = str(page['nextCursor'])
    if (!page['hasMore']) return { rows, ...(next ? { cursor: next } : cursor ? { cursor } : {}) }
    if (!next || next === cursor || cursors.has(next)) throw new Error('Bridge history cursor did not advance')
    cursors.add(next)
    cursor = next
  } while (true)
}

/** Internal materialization target. No browser import workflow and no second session store. */
export class AgentBridgeImportTarget {
  private readonly handles = new Map<string, NativeHandle>()
  private readonly jobs = new Map<string, Promise<Agent>>()
  private readonly bindings = new Map<string, JsonObject>()
  private readonly workers = new Map<string, JsonObject>()
  private readonly cursors = new Map<string, string>()
  private readonly busy = new Set<string>()
  private readonly interactions = new Map<string, Map<string, Promise<void>>>()
  private readonly abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshJob: Promise<void> | undefined
  private readonly versions = new Map<string, number>()
  private readonly placementOverrides = new Map<string, string>()
  error = ''
  lastSyncAt = 0
  constructor(readonly host: NativeHost, readonly bridge: Pick<BridgeClient, 'call'>, readonly origin: string,
    readonly dataRoot = join(homedir(), '.dsh', 'agent-bridge')) {}

  binding(nativeId: string): JsonObject | undefined {
    const cached = this.bindings.get(nativeId)
    if (cached) return cached
    const agent = this.host.agents.get(nativeId)
    const event = agent && [...sessionEvents(nativeSession(agent))].reverse().find(e => e.type === BINDING_EVENT)
    if (event && event.data['origin'] === new URL(this.origin).origin) {
      this.bindings.set(nativeId, event.data)
      return event.data
    }
    return undefined
  }
  status(): JsonObject {
    const counts: Record<string, number> = {}
    for (const [id, binding] of this.bindings) if (this.host.agents.get(id)) counts[str(binding['workerId'])] = (counts[str(binding['workerId'])] ?? 0) + 1
    return { sourceSelection: true, imageForwarding: true, nativeSessions: Object.values(counts).reduce((a, b) => a + b, 0), workers: Object.entries(counts).map(([workerId, sessions]) => ({ workerId, name: str(this.workers.get(workerId)?.['name'], workerId), sessions })), error: this.error, lastSyncAt: this.lastSyncAt }
  }
  /** An execution location is machine + remote directory, separate from a future logical project. */
  async creationSources(cwd: string): Promise<JsonObject> {
    const workerPage = record(await this.bridge.call({ operation: 'workers' }, this.abort.signal))
    if (!Array.isArray(workerPage['workers'])) throw new Error('Invalid Bridge worker page')
    this.workers.clear()
    for (const item of workerPage['workers']) { const worker = record(item); this.workers.set(str(worker['id']), worker) }
    const canonical = await realpath(cwd)
    const locations = new Map<string, { machineId: string; workspace: string }>()
    const relativePath = relative(this.dataRoot, canonical)
    let local = relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || isAbsolute(relativePath)
    // A presentation folder must never be offered as a real DSH execution directory.
    if (relative(this.dataRoot, canonical) === '') local = false
    for (const [id, binding] of this.bindings) {
      const agent = this.host.agents.get(id)
      if (!agent || nativeSession(agent).header.cwd !== canonical) continue
      const worker = this.workers.get(str(binding['workerId']))
      const machineId = str(worker?.['machineId'], str(binding['workerId']))
      const workspace = str(binding['workspace'])
      locations.set(machineId + '\0' + workspace, { machineId, workspace })
      if (worker && this.isLocalWorker(worker) && await realpath(workspace).catch(() => '') === canonical) local = true
    }
    if (local) for (const worker of this.workers.values()) if (this.isLocalWorker(worker)) {
      // Existing directories on this Host are a valid local source; the Bridge still enforces allowed roots.
      const machineId = str(worker['machineId'], str(worker['id']))
      locations.set(machineId + '\0' + canonical, { machineId, workspace: canonical })
    }
    const sources: JsonObject[] = local ? [{ id: 'dsh', name: 'DSH · ' + hostname(), machineId: 'local-dsh', workspace: canonical, available: true }] : []
    for (const location of locations.values()) for (const worker of this.workers.values()) {
      if (str(worker['machineId'], str(worker['id'])) !== location.machineId) continue
      const id = str(worker['id']) + '\0' + location.workspace
      if (sources.some(source => source['id'] === id)) continue
      sources.push({ id, workerId: str(worker['id']), name: str(worker['name'], str(worker['id'])), ...location, available: worker['status'] === 'online' })
    }
    return { cwd: canonical, sources }
  }
  async createInWorkspace(cwd: string, sourceId: string, signal?: AbortSignal): Promise<Agent> {
    const context = await this.creationSources(cwd)
    const source = (context['sources'] as JsonObject[]).find(item => item['id'] === sourceId && item['workerId'])
    if (!source || source['available'] !== true) throw new Error('Selected Bridge source is unavailable in this directory')
    const fused = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])])
    let receipt = record(await this.bridge.call({ operation: 'create_session', args: { workerId: str(source['workerId']), workspace: str(source['workspace']) } }, fused))
    while (receipt['status'] === 'accepted') {
      if (!str(receipt['actionId'])) throw new Error('Bridge create action has no identity')
      await delay(300, undefined, { signal: fused })
      receipt = record(await this.bridge.call({ operation: 'action', args: { actionId: str(receipt['actionId']) } }, fused))
    }
    if (receipt['status'] !== 'succeeded' || !str(receipt['sessionId'])) throw new Error('Bridge session creation failed: ' + JSON.stringify(receipt['error'] ?? receipt['status']))
    this.placementOverrides.set(nativeSessionId(this.origin, str(receipt['sessionId'])), str(context['cwd']))
    return this.open(str(receipt['sessionId']))
  }
  private isLocalWorker(worker: JsonObject): boolean {
    return str(worker['hostname']).toLowerCase() === hostname().toLowerCase() && (!worker['platform'] || worker['platform'] === process.platform)
  }
  isBusy(nativeId: string): boolean { return this.busy.has(nativeId) || this.host.agents.get(nativeId)?.status === 'running' }
  setBusy(nativeId: string, value: boolean): void { if (value) this.busy.add(nativeId); else this.busy.delete(nativeId) }
  acknowledge(nativeId: string, rows: readonly JsonObject[]): void {
    const agent = this.host.agents.get(nativeId)
    if (!agent) throw new Error('Native Bridge agent disappeared')
    const session = nativeSession(agent)
    const seen = new Set(sessionEvents(session).filter(e => e.type === ACK_EVENT).map(e => e.data['eventId']))
    for (const row of rows) if (!seen.has(row['eventId'])) {
      session.append(ACK_EVENT, { eventId: str(row['eventId']), turnId: str(row['turnId']) })
      seen.add(row['eventId'])
    }
  }
  async ensurePreset(): Promise<void> {
    const presets = this.host.agentPresets
    if (!presets) throw new Error('DSH agentPresets is required for isolated Bridge sessions')
    const root = presets.roots.find(root => root.trust === 'user')
    if (!root) throw new Error('DSH has no writable preset root')
    const folder = join(root.path, PROVIDER)
    await mkdir(folder, { recursive: true })
    const composition = join(folder, 'agent.cordis.yml')
    try { await writeFile(composition, '[]\n', { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if ((await readFile(composition, 'utf8')).trim() !== '[]') throw new Error('Existing agent-bridge preset is not empty; refusing to compose local tools')
    try { await writeFile(join(folder, 'preset.yml'), 'name: Agent Bridge\ndescription: Bridge remote sessions\n', { flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await presets.resolve(PROVIDER)
  }
  start(): void {
    const tick = async () => {
      try { await this.refresh() }
      catch (error) { if (!this.abort.signal.aborted) { this.error = String(error); this.host.logger.warn('Agent Bridge session sync: ' + this.error) } }
      finally { if (!this.abort.signal.aborted) { this.timer = setTimeout(() => { void tick() }, 5000); this.timer.unref?.() } }
    }
    void tick()
  }
  async dispose(): Promise<void> {
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    await this.refreshJob?.catch(() => {})
    await Promise.allSettled(this.jobs.values())
    await Promise.allSettled([...this.interactions.values()].flatMap(jobs => [...jobs.values()]))
    // Owned idle presentation agents only. Plugin reload must be refused while a native turn is running.
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
  }
  refresh(): Promise<void> {
    if (!this.refreshJob) this.refreshJob = this.refreshAll().finally(() => { this.refreshJob = undefined })
    return this.refreshJob
  }
  private async refreshAll(): Promise<void> {
    const workerPage = record(await this.bridge.call({ operation: 'workers' }, this.abort.signal))
    if (!Array.isArray(workerPage['workers'])) throw new Error('Invalid Bridge worker page')
    for (const worker of workerPage['workers']) { const row = record(worker); this.workers.set(str(row['id']), row) }
    const summaries: JsonObject[] = []
    const cursors = new Set<string>()
    let cursor = ''
    do {
      const page = record(await this.bridge.call({ operation: 'sessions', args: { limit: 200, ...(cursor ? { cursor } : {}) } }, this.abort.signal))
      if (!Array.isArray(page['data'])) throw new Error('Invalid Bridge sessions page')
      summaries.push(...page['data'].map(record))
      if (!page['hasMore']) break
      const next = str(page['nextCursor'])
      if (!next || cursors.has(next)) throw new Error('Bridge session cursor did not advance')
      cursors.add(next); cursor = next
    } while (true)
    const failures: string[] = []
    // Bounded concurrent hydration. A single broken/offline session cannot hide all other sessions.
    let index = 0
    await Promise.all(Array.from({ length: Math.min(4, summaries.length) }, async () => {
      while (index < summaries.length) {
        const row = summaries[index++]!
        const remoteId = str(row['sessionId'])
        const id = nativeSessionId(this.origin, remoteId)
        try {
          this.abort.signal.throwIfAborted()
          const current = this.host.agents.get(id)
          if (!current || this.versions.get(id) !== Number(row['updatedAt']) || ['active', 'waiting_for_approval', 'waiting_for_input'].includes(str(row['status']))) {
            await this.ensure(row)
            if (!this.isBusy(id)) this.versions.set(id, Number(row['updatedAt']))
          }
          this.host.emit('api-session/status', id, row['status'] === 'active' || row['status'] === 'waiting_for_approval' || row['status'] === 'waiting_for_input')
          if ((['waiting_for_approval', 'waiting_for_input'].includes(str(row['status'])) || this.interactions.has(id)) && !this.isBusy(id)) {
            const agent = this.host.agents.get(id)
            if (agent) {
              let jobs = this.interactions.get(id)
              if (!jobs) { jobs = new Map(); this.interactions.set(id, jobs) }
              await relayPendingInteractions(this.bridge, agent, remoteId, jobs, this.abort.signal, this.host as unknown as Context)
            }
          }
        } catch (error) { failures.push(remoteId + ': ' + String(error)) }
      }
    }))
    this.error = failures.join('\n')
    this.lastSyncAt = Date.now()
    if (failures.length) this.host.logger.warn('Agent Bridge: ' + failures.length + ' session(s) failed to sync: ' + failures.slice(0, 3).join('; '))
  }
  async open(remoteId: string): Promise<Agent> {
    const row = record(await this.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, this.abort.signal))
    return this.ensure(row)
  }
  ensure(row: JsonObject): Promise<Agent> {
    const remoteId = str(row['sessionId'])
    if (!remoteId || !str(row['workerId'])) return Promise.reject(new Error('Bridge session identity is missing'))
    const id = nativeSessionId(this.origin, remoteId)
    let job = this.jobs.get(id)
    if (!job) {
      job = this.materialize(id, row).finally(() => { this.jobs.delete(id) })
      this.jobs.set(id, job)
    }
    return job
  }
  private async workspace(row: JsonObject): Promise<{ cwd: string; title: string }> {
    const path = str(row['workspace'])
    const worker = this.workers.get(str(row['workerId']))
    if (worker && this.isLocalWorker(worker) && isAbsolute(path)) {
      try { return { cwd: await realpath(path), title: basename(path) } } catch { /* remote/missing paths use an isolated presentation directory */ }
    }
    const machineId = str(worker?.['machineId'], str(row['workerId']))
    const cwd = join(this.dataRoot, 'workspaces', hash(new URL(this.origin).origin + '\0' + machineId + '\0' + path))
    await mkdir(cwd, { recursive: true })
    return { cwd, title: path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) + ' · ' + (worker?.['machineId'] ? machineId : str(worker?.['name'], str(row['workerId']))) }
  }
  private async materialize(id: string, row: JsonObject): Promise<Agent> {
    this.abort.signal.throwIfAborted()
    const remoteId = str(row['sessionId'])
    const binding: JsonObject = { ...row, origin: new URL(this.origin).origin }
    this.bindings.set(id, binding)
    let agent = this.host.agents.get(id)
    if (agent && this.isBusy(id)) return agent
    const placement = await this.workspace(row)
    placement.cwd = this.placementOverrides.get(id) ?? placement.cwd
    const model = str(row['model'], 'remote')
    if (!agent) {
      const stored = await this.host.sessionPersistence.stat(id)
      const options = { provider: PROVIDER, model }
      const setup = async (ctx: Context) => { await this.host.agentPresets?.mount(ctx, PROVIDER) }
      let handle: NativeHandle
      if (stored) handle = await this.host.agents.resume({ resumeSessionId: id, agentOptions: options, setup })
      else {
        const history = await readHistory(this.bridge, remoteId, undefined, this.abort.signal)
        const time = Number(row['createdAt'] ?? row['updatedAt']) || Date.now()
        const seed: NativeEvent[] = [{ type: BINDING_EVENT, data: binding, seq: 0, time }]
        seed.push(...projectNativeEvents(history.rows, seed, model))
        // Empty retained histories still have a real, selectable presentation Session.
        if (!seed.some(e => e.type === 'turn/start')) seed.push(
          { type: 'turn/start', data: { turn: 1 }, seq: seed.length, time },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: seed.length + 1, time },
        )
        seed.push({ type: 'session/title', data: { title: str(row['title'], 'Bridge · ' + remoteId.slice(0, 8)), messageSeqs: [], source: { kind: 'user' } }, seq: seed.length, time })
        handle = await this.host.agents.create({ sessionId: id, meta: { cwd: placement.cwd, createdAt: time, agentPreset: PROVIDER }, seed, agentOptions: options, setup })
        if (history.cursor) this.cursors.set(id, history.cursor)
      }
      this.handles.set(id, handle); agent = handle.agent
    }
    guardImportedTurnNumbers(nativeSession(agent))
    await this.syncHistory(id, agent)
    const session = nativeSession(agent)
    const previousBinding = [...sessionEvents(session)].reverse().find(event => event.type === BINDING_EVENT)
    if (JSON.stringify(previousBinding?.data) !== JSON.stringify(binding)) session.append(BINDING_EVENT, binding)
    const title = str(row['title'], 'Bridge · ' + remoteId.slice(0, 8))
    const previous = [...sessionEvents(session)].reverse().find(e => e.type === 'session/title')
    if (previous?.data['title'] !== title) session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    if (!await this.host.sessions.flush(agent.session)) throw new Error('Native session has no persistence writer')
    const cwd = session.header.cwd ?? placement.cwd
    const workspace = await this.host.workspaceRegistry.resolveByPath(cwd) ?? await this.host.workspaceRegistry.create(cwd, placement.title)
    await workspace.attachSession(id)
    return agent
  }
  async syncHistory(id: string, agent = this.host.agents.get(id)): Promise<void> {
    const binding = this.binding(id)
    if (!agent || !binding || this.isBusy(id)) return
    let history: Awaited<ReturnType<typeof readHistory>>
    try { history = await readHistory(this.bridge, str(binding['sessionId']), this.cursors.get(id), this.abort.signal) }
    catch (error) {
      if ((error as { code?: string }).code !== 'cursor_expired') throw error
      this.cursors.delete(id)
      history = await readHistory(this.bridge, str(binding['sessionId']), undefined, this.abort.signal)
    }
    // A native prompt may have started while the HTTP read was pending.
    if (this.isBusy(id)) return
    const session = nativeSession(agent)
    for (const event of projectNativeEvents(history.rows, sessionEvents(session), str(binding['model'], 'remote'))) appendSessionEvent(session, event)
    if (history.cursor) this.cursors.set(id, history.cursor)
    await this.host.sessions.flush(agent.session)
  }
}
