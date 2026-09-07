import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ControlError } from './errors.js'
import { mockBoard } from './mock.js'
import type { JsonObject, JsonValue, KanbanCall } from './types.js'

export type PermissionMode = 'read-only' | 'orchestrator' | 'operator'
export interface KanbanConfig {
  mode: 'sidecar' | 'ssh' | 'http' | 'mock'
  board: string
  permissionMode: PermissionMode
  author: string
  hermesRoot: string
  hermesHome: string
  python: string
  sshCommand?: string
  sshHost?: string
  remoteScript?: string
  baseUrl?: string
  tokenEnv?: string
  timeoutMs: number
}

const MUTATIONS = new Set(['create', 'comment', 'link', 'request_review', 'request_changes', 'unblock', 'reassign', 'reclaim'])
const OPERATOR_ONLY = new Set(['unblock', 'reassign', 'reclaim'])

interface Pending {
  resolve(value: JsonValue): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class Sidecar {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, Pending>()
  private stopped = false

  constructor(private readonly config: KanbanConfig) {}

  async call(operation: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    if (this.stopped) throw new ControlError('kanban_disposed', 'Kanban sidecar has been disposed.', 503)
    this.ensureStarted()
    const id = randomUUID()
    return await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ControlError('kanban_timeout', 'Hermes Kanban adapter timed out.', 504, true))
      }, this.config.timeoutMs)
      const pending: Pending = { resolve, reject, timer }
      this.pending.set(id, pending)
      const abort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ControlError('cancelled', 'Kanban request was cancelled.', 499))
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.child!.stdin.write(`${JSON.stringify({ id, operation, board: this.config.board, author: this.config.author, args })}\n`, (error) => {
        if (!error) return
        signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ControlError('kanban_unavailable', error.message, 503, true))
      })
    })
  }

  dispose(): void {
    this.stopped = true
    this.child?.kill('SIGTERM')
    this.child = undefined
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new ControlError('kanban_disposed', 'Kanban sidecar stopped.', 503))
    }
    this.pending.clear()
  }

  private ensureStarted(): void {
    if (this.child !== undefined) return
    const script = fileURLToPath(new URL('../python/kanban_adapter.py', import.meta.url))
    // Strip board-pinning overrides inherited from the host process so the
    // adapter resolves the DB through HERMES_KANBAN_HOME (the isolated temp dir).
    // Without this, HERMES_KANBAN_DB / HERMES_KANBAN_BOARD from the parent env
    // short-circuit kanban_db_path() and the sidecar touches the real board.
    const env = { ...process.env }
    delete env['HERMES_KANBAN_DB']
    delete env['HERMES_KANBAN_BOARD']
    delete env['HERMES_KANBAN_WORKSPACES_ROOT']
    delete env['HERMES_KANBAN_WORKSPACE']
    delete env['HERMES_KANBAN_TASK']
    delete env['HERMES_KANBAN_RUN_ID']
    delete env['HERMES_KANBAN_CLAIM_LOCK']
    const remote = this.config.mode === 'ssh'
    const command = remote ? (this.config.sshCommand ?? 'ssh') : this.config.python
    const args = remote
      ? [
          '-o', 'BatchMode=yes',
          this.config.sshHost!,
          'env', `HERMES_HOME=${this.config.hermesHome}`, `HERMES_KANBAN_HOME=${this.config.hermesHome}`,
          this.config.python, this.config.remoteScript!, '--hermes-root', this.config.hermesRoot,
        ]
      : [script, '--hermes-root', this.config.hermesRoot]
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, HERMES_HOME: this.config.hermesHome, HERMES_KANBAN_HOME: this.config.hermesHome, PYTHONUNBUFFERED: '1' },
    })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => this.onLine(line))
    this.child.stderr.on('data', () => { /* Never relay stderr: it may contain local paths or secrets. */ })
    this.child.on('exit', () => {
      this.child = undefined
      for (const item of this.pending.values()) {
        clearTimeout(item.timer)
        item.reject(new ControlError('kanban_unavailable', 'Hermes Kanban adapter exited.', 503, true))
      }
      this.pending.clear()
    })
  }

  private onLine(line: string): void {
    let value: { id?: unknown; ok?: unknown; data?: JsonValue; error?: { code?: unknown; message?: unknown } }
    try { value = JSON.parse(line) as typeof value } catch { return }
    if (typeof value.id !== 'string') return
    const item = this.pending.get(value.id)
    if (!item) return
    this.pending.delete(value.id)
    clearTimeout(item.timer)
    if (value.ok === true && value.data !== undefined) item.resolve(value.data)
    else item.reject(new ControlError(
      typeof value.error?.code === 'string' ? value.error.code : 'kanban_error',
      typeof value.error?.message === 'string' ? value.error.message : 'Hermes Kanban operation failed.',
      409,
    ))
  }
}

export class KanbanClient {
  private readonly sidecar: Sidecar

  constructor(private readonly config: KanbanConfig) {
    this.sidecar = new Sidecar(config)
    if (config.mode === 'http' && !config.baseUrl) throw new ControlError('kanban_config_invalid', 'kanban.baseUrl is required in HTTP mode.', 500)
    if (config.mode === 'ssh' && (!config.sshHost || !config.remoteScript)) {
      throw new ControlError('kanban_config_invalid', 'kanban.sshHost and kanban.remoteScript are required in SSH mode.', 500)
    }
  }

  dispose(): void { this.sidecar.dispose() }

  async call(call: KanbanCall, signal?: AbortSignal): Promise<JsonValue> {
    this.authorize(call.operation)
    const args = call.args ?? {}
    if (call.operation === 'request_review' && args['force'] === true && this.config.permissionMode !== 'operator') {
      throw new ControlError('kanban_forbidden', 'A forced review handoff requires kanban.permissionMode=operator.', 403)
    }
    if ((call.operation === 'create' || call.operation === 'reassign') && typeof args['assignee'] === 'string' && args['assignee']) {
      await this.assertKnownAssignee(args['assignee'], signal)
    }
    return this.rawCall(call.operation, args, signal)
  }

  private rawCall(operation: KanbanCall['operation'], args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    if (this.config.mode === 'mock') return Promise.resolve(this.mock({ operation, args }))
    if (this.config.mode === 'sidecar' || this.config.mode === 'ssh') return this.sidecar.call(operation, args, signal)
    return this.http(operation, args, signal)
  }

  private async assertKnownAssignee(assignee: string, signal?: AbortSignal): Promise<void> {
    const result = await this.rawCall('assignees', {}, signal) as { assignees?: Array<string | { name?: string }> }
    const names = (result.assignees ?? []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean)
    if (!names.includes(assignee)) throw new ControlError('invalid_assignee', `Assignee ${assignee} is not a real Hermes profile.`, 400)
  }

  private authorize(operation: string): void {
    if (!MUTATIONS.has(operation)) return
    if (this.config.permissionMode === 'read-only') throw new ControlError('kanban_forbidden', 'Kanban is configured read-only.', 403)
    if (OPERATOR_ONLY.has(operation) && this.config.permissionMode !== 'operator') {
      throw new ControlError('kanban_forbidden', `${operation} requires kanban.permissionMode=operator.`, 403)
    }
  }

  private async http(operation: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    const id = (key: string) => encodeURIComponent(String(args[key] ?? ''))
    let method = 'GET'
    let path = '/board'
    let body: JsonObject | undefined
    switch (operation) {
      case 'list': break
      case 'show': path = `/tasks/${id('taskId')}`; break
      case 'create': method = 'POST'; path = '/tasks'; body = args; break
      case 'comment': method = 'POST'; path = `/tasks/${id('taskId')}/comments`; body = { body: args['body']!, author: this.config.author }; break
      case 'link': method = 'POST'; path = '/links'; body = { parent_id: args['parentId']!, child_id: args['childId']! }; break
      case 'request_review': method = 'PATCH'; path = `/tasks/${id('taskId')}`; body = { status: 'review', summary: args['summary']!, assignee: args['reviewer'] ?? null }; break
      case 'unblock': method = 'PATCH'; path = `/tasks/${id('taskId')}`; body = { status: 'ready' }; break
      case 'reassign': method = 'POST'; path = `/tasks/${id('taskId')}/reassign`; body = { profile: args['assignee'] ?? null, reclaim_first: false, reason: args['reason'] ?? null }; break
      case 'reclaim': method = 'POST'; path = `/tasks/${id('taskId')}/reclaim`; body = { reason: args['reason'] ?? null }; break
      case 'assignees': path = '/profiles'; break
      case 'request_changes': throw new ControlError('kanban_http_unsupported', 'The current Hermes dashboard has no request-changes endpoint; use sidecar mode.', 409)
      default: throw new ControlError('invalid_operation', `Unknown Kanban operation ${operation}.`, 400)
    }
    const url = new URL(path, this.config.baseUrl!.replace(/\/$/, '') + '/')
    url.searchParams.set('board', this.config.board)
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = this.config.tokenEnv ? process.env[this.config.tokenEnv] : undefined
    if (token) headers.authorization = `Bearer ${token}`
    if (body) headers['content-type'] = 'application/json'
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(url, { method, headers, signal: combined, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json().catch(() => undefined) as JsonValue | undefined
    if (!response.ok || value === undefined) throw new ControlError('kanban_http_error', `Hermes Kanban returned HTTP ${response.status}.`, response.status)
    return value
  }

  private mock(call: KanbanCall): JsonValue {
    if (call.operation === 'list') return mockBoard as unknown as JsonValue
    if (call.operation === 'assignees') return { assignees: [{ name: 'codex@hal', on_disk: true, counts: { running: 1 } }] }
    if (call.operation === 'show') {
      const taskId = call.args?.['taskId']
      const tasks = mockBoard.columns.flatMap(column => column.tasks)
      return { task: tasks.find(task => task.id === taskId) ?? null, comments: [], events: [], links: { parents: [], children: [] }, runs: [] }
    }
    return { ok: true, operation: call.operation, idempotencyKey: randomUUID() }
  }
}
