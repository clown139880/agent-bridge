import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonObject } from '../types.js'

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
  sessionPersistence: { stat(id: string): Promise<unknown> }
  workspaceRegistry: {
    resolveByPath(path: string): Promise<NativeWorkspace | undefined>
    create(path: string, title?: string): Promise<NativeWorkspace>
  }
  agentPresets?: { roots: readonly { path: string; trust: string }[]; resolve(id: string): Promise<unknown>; mount(ctx: Context, id: string): Promise<unknown> }
  emit(event: string, ...args: unknown[]): void
  logger: { warn(message: string): void }
}
export interface NativeWorkspace { attachSession(id: string): Promise<void> }
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
