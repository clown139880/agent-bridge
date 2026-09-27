import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonObject, JsonValue } from '../types.js'

/** DSH 0.1.2-rc.1 / 0.1.3-alpha.1 session and persistence seam. */
export interface NativeEvent { type: string; data: JsonObject; seq: number; time: number; surfaceOp?: 'append' }
export interface NativeSession {
  id: string
  header: { id: string; cwd?: string; createdAt: number; agentPreset?: string }
  append(type: string, data: JsonObject, options?: { surfaceOp: 'append' }): unknown
  snapshotEvents?(): readonly NativeEvent[]
  events?: readonly NativeEvent[]
}
export interface NativeHandle { agent: Agent; dispose(): Promise<void> }
export interface NativeHost {
  agents: {
    get(id: string): Agent | undefined
    list(): Agent[]
    create(options: { sessionId: string; meta: { cwd: string; createdAt: number; agentPreset: string }; seed: NativeEvent[]; agentOptions: { provider: string; model: string }; setup?(ctx: Context): Promise<void> }): Promise<NativeHandle>
    resume(options: { resumeSessionId: string; agentOptions: { provider: string; model: string }; setup?(ctx: Context): Promise<void> }): Promise<NativeHandle>
  }
  sessions: { flush(session: unknown): Promise<boolean> }
  sessionPersistence: { stat(id: string): Promise<unknown>; locate?(header: unknown): { kind?: string; path?: string } | undefined }
  workspaceRegistry: {
    archiveSession?(id: string): Promise<void>
    list?(): NativeWorkspace[]
    delete?(id: string): Promise<boolean>
    resolveByPath(path: string): Promise<NativeWorkspace | undefined>
    create(path: string, title?: string): Promise<NativeWorkspace>
  }
  agentPresets?: NativePresets
  emit(event: string, ...args: unknown[]): void
  logger: { warn(message: string): void }
}
/**
 * DSH <= 0.1.5 (TokensCowork Desktop) discovers presets from on-disk `roots`;
 * 0.1.7-rc.2 (HAL web console) removed `roots` for programmatic `register`.
 */
export interface NativePresets {
  roots?: readonly { path: string; trust: string }[]
  register?(definition: { id: string; name?: string; description?: string; order?: number; plugins: readonly unknown[] }): Promise<() => Promise<void>>
  resolve(id?: string): Promise<unknown>
  mount(ctx: Context, id?: string): Promise<unknown>
}
/**
 * tool/result seed contract. DSH <= 0.1.5 requires role "user" with exactly one
 * "tool-result" block; 0.1.7-rc.2 requires role "tool" with a top-level
 * toolCallId and dropped the block type. The two are mutually exclusive, and the
 * same release replaced preset roots with `register`, so that is the probe.
 */
export type ToolResultShape = 'tool-result-block' | 'tool-role'
export function toolResultShape(host: NativeHost): ToolResultShape {
  return typeof host.agentPresets?.register === 'function' ? 'tool-role' : 'tool-result-block'
}
export function toolResultMessage(id: string, callId: string, text: string, isError: boolean, shape: ToolResultShape): JsonObject {
  const content: JsonValue[] = [{ type: 'text', text }]
  return shape === 'tool-role'
    ? { id, role: 'tool', toolCallId: callId, isError, source: { kind: 'tool', callId }, content }
    : { id, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content, isError }] }
}
/**
 * The same tool/result message in `shape`, or undefined when it already conforms.
 * A log written under one DSH generation is refused whole by the other, so a
 * stored Bridge session is repaired by converting its own (`bridge:`) results.
 */
export function conformToolResult(message: JsonObject, shape: ToolResultShape): JsonObject | undefined {
  const id = typeof message['id'] === 'string' ? message['id'] : ''
  const source = message['source'] && typeof message['source'] === 'object' && !Array.isArray(message['source']) ? message['source'] : {}
  const callId = typeof source['callId'] === 'string' ? source['callId'] : ''
  const content = Array.isArray(message['content']) ? message['content'] : []
  const block = content.length === 1 && content[0] && typeof content[0] === 'object' && !Array.isArray(content[0]) && content[0]['type'] === 'tool-result' ? content[0] : undefined
  if (!id.startsWith('bridge:') || !callId) return undefined
  if (shape === 'tool-role' ? message['role'] === 'tool' && message['toolCallId'] === callId && !block : message['role'] === 'user' && block?.['toolCallId'] === callId && Array.isArray(block['content'])) return undefined
  const inner = block && Array.isArray(block['content']) ? block['content'] : content
  const text = inner.map(part => part && typeof part === 'object' && !Array.isArray(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : '').join('')
  return toolResultMessage(id, callId, text, (block?.['isError'] ?? message['isError']) === true, shape)
}
export interface NativeWorkspace { id?: string; path?: string; title?: string; sessionIds?: readonly string[]; setTitle?(title: string): Promise<void>; attachSession(id: string): Promise<void> }
export function nativeHost(ctx: Context): NativeHost { return ctx as unknown as NativeHost }
export function nativeSession(agent: Agent): NativeSession { return agent.session as unknown as NativeSession }
export function sessionEvents(session: NativeSession): readonly NativeEvent[] {
  if (session.snapshotEvents) return session.snapshotEvents()
  if (session.events) return session.events
  throw new Error('Unsupported DSH Session: snapshotEvents/events unavailable')
}
export function appendSessionEvent(session: NativeSession, event: Pick<NativeEvent, 'type' | 'data' | 'surfaceOp'>): void {
  if (event.surfaceOp) session.append(event.type, event.data, { surfaceOp: event.surfaceOp })
  else session.append(event.type, event.data)
}

const guardedSessions = new WeakSet<NativeSession>()
/** The native loop caches its turn counter at construction; background imports advance the log. */
export function guardImportedTurnNumbers(session: NativeSession): void {
  if (guardedSessions.has(session)) return
  guardedSessions.add(session)
  const append = session.append.bind(session)
  let maximum = sessionEvents(session).reduce((n, event) => Math.max(n, Number(event.data['turn']) || 0), 0)
  let sourceTurn = -1
  let logTurn = -1
  session.append = (type, data, options) => {
    if (type === 'turn/start' && typeof data['turn'] === 'number') {
      sourceTurn = data['turn']
      logTurn = Math.max(maximum + 1, sourceTurn)
      maximum = logTurn
    }
    return append(type, data['turn'] === sourceTurn && logTurn !== sourceTurn ? { ...data, turn: logTurn } : data, options)
  }
}
