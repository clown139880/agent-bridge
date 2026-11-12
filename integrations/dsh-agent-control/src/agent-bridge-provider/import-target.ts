import { isBridgeRecord, bridgeRecordType, appendBridgeRecord } from './records.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, readFile, writeFile, readdir } from 'node:fs/promises'
import { homedir, hostname as osHostname } from 'node:os'
import { isAbsolute, join, basename, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeClient } from '../bridge-client.js'
import { ControlError } from '../errors.js'
import type { JsonObject } from '../types.js'
import { appendSessionEvent, nativeSession, sessionEvents, toolResultShape, type NativeHost, type NativeHandle, type NativeEvent } from './dsh-compat.js'
import { ACK_EVENT, BINDING_EVENT, PROVIDER, openStep, projectNativeEvents, record, str } from './mapping.js'
import { writeSyncSidecar } from './sync-version-cache.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)
const workerAtMachine = (name: string, machineId: string) => /\s@\s/.test(name) ? name : name + ' @ ' + machineId
const inside = (root: string, path: string): boolean => {
  const value = relative(root, path)
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\'))
}
const projectName = (row: JsonObject): string => str(row['projectName']) || str(row['workspace']).replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'Bridge'
export function usefulTitle(title: unknown): boolean {
  return typeof title === 'string' && !!title.trim() && !/^(?:Bridge\s*[·:]\s*\S+|.+\s·\s[\da-f]{8}(?:-[\da-f-]+)?|(?:new|untitled)(?:\s+(?:session|conversation|chat))?|新(?:建)?(?:会话|对话)|[\da-f]{8}(?:-[\da-f-]+)?)$/i.test(title.trim())
}
export function promptTitle(row: JsonObject, events: readonly NativeEvent[]): string {
  if (usefulTitle(row['title'])) return str(row['title'])
  const prompts = events.filter(event => event.type === 'user/message' && record(event.data['source'])['kind'] === 'user')
  const recovered = prompts.find(event => JSON.stringify(event.data['content']).includes('【恢复的首条用户消息】'))
  const first = recovered ?? prompts[0]
  const text = first && Array.isArray(first.data['content']) ? first.data['content'].map(block => record(block)['type'] === 'text' ? str(record(block)['text']) : '').join(' ') : ''
  const prompt = (text || str(row['promptSummary'])).replace(/^【恢复的首条用户消息】\s*/, '').replace(/\s+/g, ' ').trim()
  return prompt ? Array.from(prompt).slice(0, 64).join('') + (Array.from(prompt).length > 64 ? '…' : '') : 'Bridge · ' + str(row['sessionId']).slice(0, 8)
}
// os.hostname() is a syscall; the catalog asks once per session on every client poll.
let cachedHostname: string | undefined
const hostname = (): string => cachedHostname ??= osHostname()
const FULL_SYNC_MS = 60_000
/** Sidebar recency: the user's last prompt, as in the Control Center. Agent replies,
 * tool progress and status changes do not reorder the list (a reply clock moved
 * every running session on each assistant message); a session without a prompt
 * yet ranks by its creation. */
export function activityAt(binding: JsonObject): number {
  return Number(binding['lastPromptAt']) || Number(binding['createdAt']) || Number(binding['updatedAt']) || 0
}
export function nativeSessionId(origin: string, sessionId: string): string {
  return 'agent-bridge-' + hash(new URL(origin).origin + '\0' + sessionId)
}
export async function readHistory(bridge: Pick<BridgeClient, 'call'>, sessionId: string, after?: string, signal?: AbortSignal, limit = 200): Promise<{ rows: JsonObject[]; cursor?: string }> {
  const rows: JsonObject[] = []
  const cursors = new Set<string>()
  let cursor = after
  do {
    signal?.throwIfAborted()
    const page = record(await bridge.call({ operation: 'session_events', args: { sessionId, limit, ...(cursor ? { after: cursor } : {}) } }, signal))
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

/**
 * The catalog of Bridge sessions, which DSH shows as client-side virtual sessions
 * (remote-sessions/), and the local drafts that become Bridge sessions with their
 * first message. A remote session is never stored as a native DSH session.
 */
export class AgentBridgeImportTarget {
  private readonly handles = new Map<string, NativeHandle>()
  private readonly bindings = new Map<string, JsonObject>()
  private readonly workers = new Map<string, JsonObject>()
  private readonly busy = new Set<string>()
  private readonly abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshJob: Promise<void> | undefined
  private presetDisposer: (() => Promise<void>) | undefined
  /** Control-plane stream position of the last complete pass that left nothing deferred. */
  private synced: { cursor: string; at: number } | undefined
  private readonly placementOverrides = new Map<string, string>()
  private readonly presentationPlacements = new Map<string, string>()
  private readonly presentationGroups = new Map<string, JsonObject>()
  error = ''
  lastSyncAt = 0
  private readonly deleting = new Set<string>()
  private readonly deleted = new Set<string>()
  /** Remote id → native id for drafts, whose native id predates (so is not derived from) their remote id. */
  private readonly aliases = new Map<string, string>()
  private aliasesLoaded: Promise<void> | undefined
  /** Drafts whose remote session is being created; its id is not known until the action settles. */
  private readonly drafting = new Set<string>()
  constructor(readonly host: NativeHost, readonly bridge: Pick<BridgeClient, 'call'>, readonly origin: string,
    readonly dataRoot = join(homedir(), '.dsh', 'agent-bridge')) {}

  binding(nativeId: string): JsonObject | undefined {
    const cached = this.bindings.get(nativeId)
    if (cached) return cached
    const agent = this.host.agents.get(nativeId)
    const event = agent && [...sessionEvents(nativeSession(agent))].reverse().find(e => isBridgeRecord(e.type, BINDING_EVENT))
    if (event && event.data['origin'] === new URL(this.origin).origin) {
      this.bindings.set(nativeId, event.data)
      return event.data
    }
    return undefined
  }
  /** A draft is a local session whose Bridge session is only created by its first message. */
  isDraft(nativeId: string): boolean {
    const binding = this.binding(nativeId)
    return !!binding && !str(binding['sessionId'])
  }
  private nativeIdFor(remoteId: string): string {
    return this.aliases.get(remoteId) ?? nativeSessionId(this.origin, remoteId)
  }
  private loadAliases(): Promise<void> {
    this.aliasesLoaded ??= (async () => {
      const directory = join(this.dataRoot, 'draft-aliases')
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const alias = record(JSON.parse(await readFile(join(directory, file), 'utf8')))
        if (alias['origin'] === new URL(this.origin).origin && str(alias['remoteId']) && str(alias['nativeId'])) this.aliases.set(str(alias['remoteId']), str(alias['nativeId']))
      }
    })()
    return this.aliasesLoaded
  }
  status(): JsonObject {
    const counts: Record<string, number> = {}
    for (const [id, binding] of this.bindings) if (this.host.agents.get(id)) counts[str(binding['workerId'])] = (counts[str(binding['workerId'])] ?? 0) + 1
    return { sourceSelection: true, imageForwarding: true, nativeSessions: Object.values(counts).reduce((a, b) => a + b, 0), workers: Object.entries(counts).map(([workerId, sessions]) => ({ workerId, name: str(this.workers.get(workerId)?.['name'], workerId), sessions })), error: this.error, lastSyncAt: this.lastSyncAt }
  }
  /** The catalog's Bridge identities and statuses, without assembling the rest of each entry. */
  sessionStatuses(): { sessionId: string; status: string }[] {
    return [...this.bindings].filter(([id]) => !this.deleted.has(id))
      .map(([, binding]) => ({ sessionId: str(binding['sessionId']), status: str(binding['status']) }))
  }
  catalog(): JsonObject {
    const groups = [...this.presentationGroups.values()].map(group => ({ ...group, executionLocations: Array.isArray(group['executionLocations'])
      ? group['executionLocations'].map(record).map(location => ({ ...location, local: this.isLocalWorker(this.workers.get(str(location['workerId'])) ?? {}) })) : [] }))
    return { groups, sessions: [...this.bindings].filter(([id]) => !this.deleted.has(id))
      .sort(([, left], [, right]) => Number(left['presentationOrder']) - Number(right['presentationOrder']))
      .map(([nativeId, binding]) => {
      const worker = this.workers.get(str(binding['workerId']))
      const machineId = str(worker?.['machineId'], str(binding['workerId']))
      const workspace = str(binding['workspace'])
      const placementKey = 'group\0' + str(binding['groupId'])
      const recent = Array.isArray(worker?.['recentWorkspaces'])
        ? worker['recentWorkspaces'].map(record).find(item => str(item['path']) === workspace)
        : undefined
      const lastUsedAt = typeof recent?.['lastUsedAt'] === 'number' && Number.isFinite(recent['lastUsedAt']) ? recent['lastUsedAt'] : undefined
      const agent = this.host.agents.get(nativeId)
      const executionLocations = Array.isArray(binding['executionLocations']) ? binding['executionLocations'].map(record).map(location => ({
        ...location, local: this.isLocalWorker(this.workers.get(str(location['workerId'])) ?? {}),
      })) : []
      return { nativeId, sessionId: str(binding['sessionId']), workerId: str(binding['workerId']), machineId, workspace,
        groupId: str(binding['groupId']), groupTitle: str(binding['groupTitle']), groupUpdatedAt: Number(binding['groupUpdatedAt']) || Number(binding['updatedAt']) || 0,
        executionLocations,
        ...(str(binding['model'], '') ? { model: str(binding['model']) } : {}),
        ...(str(binding['projectIdentity']) ? { projectIdentity: str(binding['projectIdentity']) } : {}),
        // Started by an automation run: the sidebar, like the Control Center's list, leaves it out.
        ...(str(binding['automation']) ? { automation: str(binding['automation']) } : {}),
        ...(this.presentationPlacements.get(placementKey) ? { presentationPath: this.presentationPlacements.get(placementKey)! } : {}),
        title: agent ? promptTitle(binding, sessionEvents(nativeSession(agent))) : str(binding['title']),
        status: str(binding['status']), worker: str(worker?.['name'], str(binding['workerId'])),
        updatedAt: Number(binding['updatedAt']) || 0, activityAt: activityAt(binding), ...(lastUsedAt === undefined ? {} : { lastUsedAt }) }
    }) }
  }
  async deleteNative(nativeId: string, signal?: AbortSignal): Promise<JsonObject> {
    const binding = this.binding(nativeId)
    if (!binding) {
      // Imported ids must never fall through to local-only removal when their
      // Bridge binding has not loaded yet.
      if (nativeId.startsWith('agent-bridge-')) throw new Error('Bridge 会话尚未加载，请稍后重试')
      if (!/^[A-Za-z0-9_-]+$/.test(nativeId)) throw new Error('无效的会话 ID')
      if (!this.host.workspaceRegistry.archiveSession) throw new Error('客户端不支持会话移除')
      if (this.isBusy(nativeId)) throw new Error('请先结束当前回合并处理待确认事项，再删除会话')
      const agent = this.host.agents.get(nativeId)
      if (!agent && !await this.host.sessionPersistence.stat(nativeId)) throw new Error('会话不存在')
      if (this.isBusy(nativeId)) throw new Error('会话正在运行，请稍后重试')
      // Logical deletion is durable and separate from ordinary archive. Keep
      // the original log intact; it may contain lineage used by forked sessions.
      const directory = join(this.dataRoot, 'deleted-native-sessions')
      await mkdir(directory, { recursive: true })
      await writeSyncSidecar(join(directory, nativeId + '.json'), { nativeId, deletedAt: Date.now() })
      await this.host.workspaceRegistry.archiveSession(nativeId)
      return { deleted: true, nativeId }
    }
    if (!this.host.workspaceRegistry.archiveSession) throw new Error('客户端不支持会话移除')
    if (this.isBusy(nativeId) || ['active', 'waiting_for_approval', 'waiting_for_input'].includes(str(binding['status']))) throw new Error('请先结束当前回合并处理待确认事项，再删除会话')
    if (this.deleting.has(nativeId)) throw new Error('正在删除此会话')
    // A draft never reached the Bridge, so there is nothing remote to delete.
    if (!str(binding['sessionId'])) {
      const localWarning = await this.cleanupDeletedNative(nativeId)
      return { deleted: true, nativeId, ...(localWarning ? { localWarning } : {}) }
    }
    this.deleting.add(nativeId)
    try {
      const fused = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])])
      let receipt: JsonObject
      try { receipt = record(await this.bridge.call({ operation: 'delete_session', args: { sessionId: str(binding['sessionId']) } }, fused)) }
      catch (error) {
        if (!(error instanceof ControlError) || error.code !== 'session_not_found') throw error
        const localWarning = await this.cleanupDeletedNative(nativeId)
        return { deleted: true, nativeId, alreadyDeleted: true, ...(localWarning ? { localWarning } : {}) }
      }
      while (receipt['status'] === 'accepted') {
        if (!str(receipt['actionId'])) throw new Error('删除操作缺少标识')
        await delay(300, undefined, { signal: fused })
        receipt = record(await this.bridge.call({ operation: 'action', args: { actionId: str(receipt['actionId']) } }, fused))
      }
      if ((receipt['status'] !== 'succeeded' && receipt['deleted'] !== true) || receipt['sessionId'] !== binding['sessionId']) {
        const failure = record(receipt['error'])
        throw new ControlError(str(failure['code'], 'delete_failed'), str(failure['message'], 'Bridge 会话删除失败'), 409, failure['retryable'] === true)
      }
      const localWarning = await this.cleanupDeletedNative(nativeId)
      return { deleted: true, nativeId, ...(localWarning ? { localWarning } : {}) }
    } finally { this.deleting.delete(nativeId) }
  }
  async deleteNativeWorkspace(nativeIds: readonly string[], signal?: AbortSignal): Promise<JsonObject> {
    const ids = [...new Set(nativeIds)]
    if (!ids.length) throw new Error('工作区中没有 Bridge 会话')
    // Validate the entire workspace before the first remote mutation. This keeps
    // one busy or stale child from turning a workspace deletion into a partial
    // delete merely because it happened to appear later in the list.
    for (const id of ids) {
      const binding = this.binding(id)
      if (!binding) throw new Error(id.startsWith('agent-bridge-') ? 'Bridge 会话尚未加载，请稍后重试' : '工作区包含非 Bridge 会话')
      if (this.isBusy(id) || this.deleting.has(id) || ['active', 'waiting_for_approval', 'waiting_for_input'].includes(str(binding['status']))) {
        throw new Error('请先结束工作区内所有当前回合并处理待确认事项，再删除工作区')
      }
    }
    for (const id of ids) await this.deleteNative(id, signal)
    return { deleted: true, nativeIds: ids }
  }
  private async cleanupDeletedNative(nativeId: string): Promise<string> {
    // A confirmed Bridge deletion cannot be rolled back. Stale DSH workspace
    // references must not turn that success into a misleading retryable 500.
    this.deleted.add(nativeId)
    const warnings: string[] = []
    try { await this.host.workspaceRegistry.archiveSession?.(nativeId) }
    catch (error) { warnings.push('archive: ' + String(error)) }
    try { await this.handles.get(nativeId)?.dispose() }
    catch (error) { warnings.push('dispose: ' + String(error)) }
    this.handles.delete(nativeId)
    if (warnings.length) this.host.logger.warn(`Agent Bridge local cleanup for "${nativeId}" was incomplete after remote deletion: ${warnings.join('; ')}`)
    return warnings.join('; ')
  }
  /** An execution location remains machine + remote directory even when repository presentation is merged. */
  async creationSources(cwd: string): Promise<JsonObject> {
    const workerPage = record(await this.bridge.call({ operation: 'workers' }, this.abort.signal))
    if (!Array.isArray(workerPage['workers'])) throw new Error('Invalid Bridge worker page')
    this.workers.clear()
    for (const item of workerPage['workers']) { const worker = record(item); this.workers.set(str(worker['id']), worker) }
    const canonical = await realpath(cwd)
    const locations = new Map<string, { machineId: string; workspace: string }>()
    const direct: Array<{ binding: JsonObject; machineId: string; workspace: string }> = []
    const relativePath = relative(this.dataRoot, canonical)
    let local = relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || isAbsolute(relativePath)
    // A presentation folder must never be offered as a real DSH execution directory.
    if (relative(this.dataRoot, canonical) === '') local = false
    for (const [id, binding] of this.bindings) {
      const agent = this.host.agents.get(id)
      const placement = this.placementOverrides.get(id) ?? this.presentationPlacements.get('group\0' + str(binding['groupId']))
        ?? (agent ? nativeSession(agent).header.cwd : undefined)
      if (!placement || await realpath(placement).catch(() => '') !== canonical) continue
      const worker = this.workers.get(str(binding['workerId']))
      const machineId = str(worker?.['machineId'], str(binding['workerId']))
      const workspace = str(binding['workspace'])
      direct.push({ binding, machineId, workspace })
      if (worker && this.isLocalWorker(worker) && await realpath(workspace).catch(() => '') === canonical) local = true
    }
    const identities = new Set(direct.map(item => str(item.binding['projectIdentity'])).filter(Boolean))
    if (identities.size === 1) {
      const [identity] = identities
      for (const binding of this.bindings.values()) if (str(binding['projectIdentity']) === identity) {
        const worker = this.workers.get(str(binding['workerId']))
        const machineId = str(worker?.['machineId'], str(binding['workerId']))
        const workspace = str(binding['workspace'])
        locations.set(machineId + '\0' + workspace, { machineId, workspace })
      }
    } else for (const location of direct) {
      locations.set(location.machineId + '\0' + location.workspace, location)
    }
    if (local) for (const worker of this.workers.values()) if (this.isLocalWorker(worker)) {
      // Existing directories on this Host are a valid local source; the Bridge still enforces allowed roots.
      const machineId = str(worker['machineId'], str(worker['id']))
      locations.set(machineId + '\0' + canonical, { machineId, workspace: canonical })
    }
    const sources: JsonObject[] = local ? [{ id: 'dsh', name: 'DSH @ ' + hostname(), agentType: 'dsh', machineId: 'local-dsh', machineName: hostname(), platform: process.platform, local: true, workspace: canonical, available: true }] : []
    for (const location of locations.values()) for (const worker of this.workers.values()) {
      if (str(worker['machineId'], str(worker['id'])) !== location.machineId) continue
      const id = str(worker['id']) + '\0' + location.workspace
      if (sources.some(source => source['id'] === id)) continue
      const name = str(worker['name'], str(worker['id']))
      // The picker groups by machine and badges by agent; older Bridges only send the combined name.
      sources.push({ id, workerId: str(worker['id']), name: workerAtMachine(name, location.machineId), agentType: str(worker['agentType']),
        machineName: str(worker['machineName'], name.split(/\s@\s/)[1] ?? location.machineId), platform: str(worker['platform']),
        local: this.isLocalWorker(worker), ...location, available: worker['status'] === 'online' })
    }
    return { cwd: canonical, sources }
  }
  async createInWorkspace(directory: string, sourceId: string, signal?: AbortSignal): Promise<Agent> {
    const context = await this.creationSources(directory)
    const source = (context['sources'] as JsonObject[]).find(item => item['id'] === sourceId && item['workerId'])
    if (!source || source['available'] !== true) throw new Error('Selected Bridge source is unavailable in this directory')
    signal?.throwIfAborted()
    // Only a local draft for now: the Bridge session is created by the first
    // message (see createDraftRemote), so an abandoned "new session" leaves no
    // empty remote session behind.
    const cwd = str(context['cwd'])
    const workerId = str(source['workerId'])
    const workspace = str(source['workspace'])
    const origin = new URL(this.origin).origin
    const id = 'agent-bridge-' + hash(origin + '\0draft\0' + randomUUID())
    // Join the presentation group of a sibling in this directory so the catalog
    // lists the draft with it, not in a group of its own.
    const placedIn = (nativeId: string) => {
      const agent = this.host.agents.get(nativeId)
      const binding = this.bindings.get(nativeId)
      return this.placementOverrides.get(nativeId) ?? this.presentationPlacements.get('group\0' + str(binding?.['groupId']))
        ?? (agent ? nativeSession(agent).header.cwd : undefined)
    }
    const sibling = [...this.bindings].find(([nativeId, binding]) => str(binding['sessionId']) && str(binding['workspace']) === workspace && placedIn(nativeId) === cwd)?.[1]
    const time = Date.now()
    const binding: JsonObject = { origin, workerId, workspace, status: 'idle', createdAt: time, updatedAt: time, presentationOrder: -1,
      groupId: str(sibling?.['groupId'], 'draft:' + id), groupTitle: str(sibling?.['groupTitle'], basename(cwd)), groupUpdatedAt: time,
      executionLocations: Array.isArray(sibling?.['executionLocations']) ? sibling['executionLocations'] : [{ workerId, machineId: str(source['machineId']), workspace }],
      ...(str(sibling?.['projectIdentity']) ? { projectIdentity: str(sibling?.['projectIdentity']) } : {}) }
    const seed: NativeEvent[] = [
      { type: bridgeRecordType(BINDING_EVENT), ignorable: true, data: binding, seq: 0, time },
      { type: 'session/title', data: { title: '新会话', messageSeqs: [], source: { kind: 'user' } }, seq: 1, time },
    ]
    const setup = async (ctx: Context) => { await this.host.agentPresets?.mount(ctx, PROVIDER) }
    const handle = await this.host.agents.create({ sessionId: id, meta: { cwd, createdAt: time, agentPreset: PROVIDER }, seed, agentOptions: { provider: PROVIDER, model: 'remote' }, setup })
    this.handles.set(id, handle)
    this.bindings.set(id, binding)
    this.placementOverrides.set(id, cwd)
    if (!await this.host.sessions.flush(handle.agent.session)) throw new Error('Native session has no persistence writer')
    const registered = await this.host.workspaceRegistry.resolveByPath(cwd) ?? await this.host.workspaceRegistry.create(cwd, basename(cwd))
    await registered.attachSession(id)
    return handle.agent
  }
  /**
   * Create the Bridge session behind a draft with its first message, then bind the
   * draft to it. Returns the settled create action, which carries the first turn.
   */
  async createDraftRemote(nativeId: string, args: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const binding = this.binding(nativeId)
    if (!binding || str(binding['sessionId'])) throw new Error('This DSH session is not a Bridge draft')
    await this.loadAliases()
    this.drafting.add(nativeId)
    try {
      let receipt = record(await this.bridge.call({ operation: 'create_session', args: { ...args, workerId: str(binding['workerId']), workspace: str(binding['workspace']) } }, signal))
      while (receipt['status'] === 'accepted') {
        if (!str(receipt['actionId'])) throw new Error('Bridge create action has no identity')
        await delay(300, undefined, { signal })
        receipt = record(await this.bridge.call({ operation: 'action', args: { actionId: str(receipt['actionId']) } }, signal))
      }
      const remoteId = str(receipt['sessionId'])
      if (receipt['status'] !== 'succeeded' || !remoteId) throw new Error('Bridge session creation failed: ' + JSON.stringify(receipt['error'] ?? receipt['status']))
      // Persist the alias before the binding so a restart never materializes the
      // remote session a second time under its derived id.
      const directory = join(this.dataRoot, 'draft-aliases')
      await mkdir(directory, { recursive: true })
      await writeSyncSidecar(join(directory, nativeSessionId(this.origin, remoteId) + '.json'), { origin: binding['origin'], remoteId, nativeId })
      this.aliases.set(remoteId, nativeId)
      const bound: JsonObject = { ...binding, sessionId: remoteId }
      this.bindings.set(nativeId, bound)
      const agent = this.host.agents.get(nativeId)
      if (agent) appendBridgeRecord(nativeSession(agent), BINDING_EVENT, bound)
      return receipt
    } finally { this.drafting.delete(nativeId) }
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
    const seen = new Set(sessionEvents(session).filter(e => isBridgeRecord(e.type, ACK_EVENT)).map(e => e.data['eventId']))
    for (const row of rows) if (!seen.has(row['eventId'])) {
      appendBridgeRecord(session, ACK_EVENT, { eventId: str(row['eventId']), turnId: str(row['turnId']), ...(str(row['localMessageId']) ? { localMessageId: str(row['localMessageId']) } : {}) })
      seen.add(row['eventId'])
    }
  }
  /**
   * Show remote output while its turn runs. Rows join the native loop's open
   * turn and step in arrival order; they are acknowledged as they land, so the
   * background sync and a later turn never show them again. With no turn open
   * (the loop has already closed it) they become closed turns, as a sync would.
   */
  presentLive(nativeId: string, rows: readonly JsonObject[]): void {
    if (!rows.length) return
    const agent = this.host.agents.get(nativeId)
    if (!agent) throw new Error('Native Bridge agent disappeared')
    const session = nativeSession(agent)
    const existing = sessionEvents(session)
    for (const event of projectNativeEvents(rows, existing, str(this.binding(nativeId)?.['model'], 'remote'), toolResultShape(this.host), openStep(existing))) appendSessionEvent(session, event)
  }
  async ensurePreset(): Promise<void> {
    const presets = this.host.agentPresets
    if (!presets) throw new Error('DSH agentPresets is required for isolated Bridge sessions')
    // DSH 0.1.7-rc.2 replaced the on-disk preset roots with programmatic
    // registration; DSH <= 0.1.5 (Desktop) only has the roots. Either way the
    // preset is isolated and empty (no local tools). The register disposer is
    // released on dispose so hot reload can re-register.
    if (presets.register) {
      if (!this.presetDisposer) {
        this.presetDisposer = await presets.register({ id: PROVIDER, name: 'Agent Bridge', description: 'Bridge remote sessions', plugins: [] })
      }
    } else {
      const root = presets.roots?.find(root => root.trust === 'user')
      if (!root) throw new Error('DSH has no writable preset root')
      const folder = join(root.path, PROVIDER)
      await mkdir(folder, { recursive: true })
      const composition = join(folder, 'agent.cordis.yml')
      try { await writeFile(composition, '[]\n', { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if ((await readFile(composition, 'utf8')).trim() !== '[]') throw new Error('Existing agent-bridge preset is not empty; refusing to compose local tools')
      try { await writeFile(join(folder, 'preset.yml'), 'name: Agent Bridge\ndescription: Bridge remote sessions\n', { flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    await presets.resolve(PROVIDER)
  }
  async restoreLocalDeletions(): Promise<void> {
    const directory = join(this.dataRoot, 'deleted-native-sessions')
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const file of files) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) continue
      const record = JSON.parse(await readFile(join(directory, file), 'utf8')) as { nativeId?: string }
      if (record.nativeId + '.json' !== file) throw new Error('无效的本地删除记录')
      await this.host.workspaceRegistry.archiveSession?.(record.nativeId!)
    }
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
    // Owned idle presentation agents only. Plugin reload must be refused while a native turn is running.
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
    await this.presetDisposer?.().catch(() => {})
    this.presetDisposer = undefined
  }
  refresh(): Promise<void> {
    if (!this.refreshJob) this.refreshJob = this.refreshAll().finally(() => { this.refreshJob = undefined })
    return this.refreshJob
  }
  private async refreshAll(): Promise<void> {
    await this.loadAliases()
    const workerPage = record(await this.bridge.call({ operation: 'workers' }, this.abort.signal))
    if (!Array.isArray(workerPage['workers'])) throw new Error('Invalid Bridge worker page')
    for (const worker of workerPage['workers']) { const row = record(worker); this.workers.set(str(row['id']), row) }
    // Every session, worker and pending-interaction change advances the stream cursor. When it has
    // not moved since a clean pass, the catalog is unchanged; skip it, with a periodic full backstop.
    const stream = str(workerPage['streamCursor'])
    if (stream && this.synced?.cursor === stream && Date.now() - this.synced.at < FULL_SYNC_MS) {
      this.lastSyncAt = Date.now()
      return
    }
    this.synced = undefined
    let deferred = false
    const summaries: JsonObject[] = []
    const groups: JsonObject[] = []
    const cursors = new Set<string>()
    let cursor = ''
    do {
      const page = record(await this.bridge.call({ operation: 'session_groups', args: { limit: 200, ...(cursor ? { cursor } : {}) } }, this.abort.signal))
      if (!Array.isArray(page['data'])) throw new Error('Invalid Bridge presentation-group page')
      for (const value of page['data']) {
        const group = record(value)
        if (!str(group['groupId']) || !Array.isArray(group['sessions'])) throw new Error('Invalid Bridge presentation group')
        groups.push(group)
        for (const value of group['sessions']) summaries.push({ ...record(value), groupId: str(group['groupId']), groupTitle: str(group['title']),
          groupUpdatedAt: Number(group['updatedAt']) || 0, presentationOrder: summaries.length,
          executionLocations: Array.isArray(group['executionLocations']) ? group['executionLocations'] : [] })
      }
      if (!page['hasMore']) break
      const next = str(page['nextCursor'])
      if (!next || cursors.has(next)) throw new Error('Bridge session cursor did not advance')
      cursors.add(next); cursor = next
    } while (true)
    this.presentationPlacements.clear()
    this.presentationGroups.clear()
    for (const group of groups) this.presentationGroups.set(str(group['groupId']), group)
    this.preparePresentationPlacements(groups)
    // The complete control-plane catalog is authoritative. Retry local cleanup after
    // a confirmed remote deletion even if the previous Host exited before archiving.
    const retained = new Set(summaries.map(row => str(row['sessionId'])))
    for (const [id, binding] of this.bindings) {
      // Drafts have no remote session yet, so the remote catalog cannot vouch for them.
      if (!str(binding['sessionId'])) continue
      if (retained.has(str(binding['sessionId'])) || this.isBusy(id) || this.deleting.has(id) || this.deleted.has(id)) continue
      await this.cleanupDeletedNative(id)
    }
    // Every row is a catalog binding only; the virtual session shows its history.
    for (const row of summaries) {
      const remoteId = str(row['sessionId'])
      const id = this.nativeIdFor(remoteId)
      if (this.deleting.has(id) || this.deleted.has(id)) continue
      // While a draft's create action is pending, a new session in its location
      // may be that draft's; wait for the binding rather than record a twin.
      if (!this.aliases.has(remoteId) && !this.bindings.has(id) && [...this.drafting].some(draft =>
        str(this.bindings.get(draft)?.['workerId']) === str(row['workerId']) && str(this.bindings.get(draft)?.['workspace']) === str(row['workspace']))) { deferred = true; continue }
      this.bindings.set(id, { ...row, origin: new URL(this.origin).origin })
    }
    await this.reconcilePresentationWorkspaces(groups)
    this.error = ''
    this.lastSyncAt = Date.now()
    if (stream && !deferred) this.synced = { cursor: stream, at: this.lastSyncAt }
  }
  private preparePresentationPlacements(groups: readonly JsonObject[]): void {
    const workspaces = this.host.workspaceRegistry.list?.()
    if (!workspaces) return
    for (const group of groups) {
      const groupId = str(group['groupId']); const key = 'group\0' + groupId
      const rows = Array.isArray(group['sessions']) ? group['sessions'].map(record) : []
      const ids = new Set(rows.map(row => this.nativeIdFor(str(row['sessionId']))))
      const members = workspaces.filter(workspace => workspace.sessionIds?.some(id => ids.has(id)))
      const expected = join(this.dataRoot, 'groups', hash(new URL(this.origin).origin + '\0' + groupId))
      const keep = members.find(workspace => workspace.path && !inside(this.dataRoot, workspace.path))
        ?? members.find(workspace => workspace.path === expected)
      if (keep?.path) this.presentationPlacements.set(key, keep.path)
    }
  }
  private async reconcilePresentationWorkspaces(groups: readonly JsonObject[]): Promise<void> {
    const registry = this.host.workspaceRegistry
    if (!registry.list || !registry.delete) return
    const groupRoot = await realpath(join(this.dataRoot, 'groups')).catch(() => join(this.dataRoot, 'groups'))
    for (const group of groups) {
      const groupId = str(group['groupId']); const key = 'group\0' + groupId
      const rows = Array.isArray(group['sessions']) ? group['sessions'].map(record) : []
      const ids = new Set(rows.map(row => this.nativeIdFor(str(row['sessionId']))))
      const members = registry.list().filter(workspace => workspace.sessionIds?.some(id => ids.has(id)))
      const cwd = join(this.dataRoot, 'groups', hash(new URL(this.origin).origin + '\0' + groupId))
      let keep = members.find(workspace => workspace.path && !inside(this.dataRoot, workspace.path))
      keep ??= members.find(workspace => workspace.path === cwd)
      if (!keep) {
        await mkdir(cwd, { recursive: true })
        keep = await registry.resolveByPath(cwd) ?? await registry.create(cwd, str(group['title'], projectName(rows[0]!)))
      }
      if (!keep.path) continue
      this.presentationPlacements.set(key, keep.path)
      // DSH persists every setTitle (new updatedAt, an upsert to each client) even
      // when the title is the same; a live catalog reconciles every few seconds.
      const title = str(group['title'], projectName(rows[0]!))
      if (inside(this.dataRoot, keep.path) && keep.title !== title) await keep.setTitle?.(title)
      for (const workspace of members) {
        if (workspace === keep || !workspace.id || !workspace.path || !inside(this.dataRoot, workspace.path)) continue
        await registry.delete(workspace.id)
      }
    }
    const activePresentationPaths = new Set(this.presentationPlacements.values())
    for (const workspace of registry.list()) {
      if (!workspace.id || !workspace.path) continue
      if (inside(groupRoot, workspace.path) && !activePresentationPaths.has(workspace.path)) await registry.delete(workspace.id)
    }
  }
}
