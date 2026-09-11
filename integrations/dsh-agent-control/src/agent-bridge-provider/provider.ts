import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AgentControlService } from '../service.js'
import { AgentBridgeLlmAdapter } from './adapter.js'
import { AgentBridgeImportTarget } from './import-target.js'
import { nativeHost, type NativeSession, type NativeEvent } from './dsh-compat.js'
import { ACK_EVENT, BINDING_EVENT, PROVIDER } from './mapping.js'

// Retained plugin events must remain readable even during dependency reload.
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(BINDING_EVENT)
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(ACK_EVENT)

export function registerAgentBridgeProvider(ctx: Context, service: AgentControlService): void {
  ctx.inject(['llm', 'agents', 'sessions', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'approval', 'userQuestions'], scoped => {
    const target = new AgentBridgeImportTarget(nativeHost(scoped), service.bridge, service.config.bridge.origin)
    const adapter = new AgentBridgeLlmAdapter(service, target)
    const llm = scoped as unknown as { llm: { registerAdapter(providers: string[], adapter: AgentBridgeLlmAdapter): () => void } }
    const registration = llm.llm.registerAdapter([PROVIDER], adapter)
    service.importTarget = target
    const attach = (agent: Agent) => {
      if (!target.binding(String(agent.id)) && agent.session.header.agentPreset !== PROVIDER) return
      agent.options.provider = PROVIDER
      agent.options.model = 'remote'
      installModelSelection(agent.ctx, { current: { provider: PROVIDER, model: 'remote' }, assembled: undefined })
    }
    scoped.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      if (options.purpose || !options.sessionId) return next()
      return target.binding(String(options.sessionId)) ? adapter.stream(options) : next()
    }, { global: true, prepend: true })
    scoped.on('agent/created', ({ agent }: { agent: Agent }) => attach(agent), { global: true })
    scoped.on('agent/disposed', ({ agent }: { agent: Agent }) => adapter.detachAgent(agent.id), { global: true })
    scoped.on('session/event', ((session: NativeSession, event: NativeEvent) => {
      if (event.type === 'turn/end') queueMicrotask(() => {
        try { adapter.commitAcks(session.id) }
        catch (error) { scoped.logger.warn('Bridge event acknowledgement: ' + String(error)) }
      })
    }) as never, { global: true })
    scoped.effect(() => {
      let disposed = false
      const ready = target.restoreLocalDeletions().then(() => target.ensurePreset()).then(() => { if (!disposed) target.start() }).catch(error => {
        target.error = String(error); scoped.logger.warn('Agent Bridge provider: ' + String(error))
      })
      return async () => {
        disposed = true
        if (service.importTarget === target) service.importTarget = undefined
        await ready
        await target.dispose()
        registration()
      }
    }, 'agent-bridge: native session provider')
    for (const agent of nativeHost(scoped).agents.list()) attach(agent)
  })
}
