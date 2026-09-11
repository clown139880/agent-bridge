import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ControlError, errorResponse } from './errors.js'
import { AgentControlService, type AgentControlConfig } from './service.js'
import { registerAgentBridgeProvider } from './agent-bridge-provider/provider.js'
import { MUTATING_TOOL_NAMES, registerTools } from './tools.js'
import type { DashboardRequest } from './types.js'

export * from './bridge-client.js'
export * from './errors.js'
export * from './kanban-client.js'
export * from './service.js'
export * from './types.js'
export { AgentBridgeImportTarget } from './agent-bridge-provider/import-target.js'
export { AgentBridgeLlmAdapter } from './agent-bridge-provider/adapter.js'
export { projectNativeEvents } from './agent-bridge-provider/mapping.js'
export { MUTATING_TOOL_NAMES, TOOL_SPECS } from './tools.js'
export const name = 'agent-control'
export const inject = ['tools', 'systemPrompt', 'connection']
export const AGENT_CONTROL_PATH = '/api/agent-control'
export const AGENT_CONTROL_STREAM_PATH = '/api/agent-control.stream'
const AGENT_CONTROL_RPC_CHANNEL = '/agent-control'
export interface Config extends AgentControlConfig {}

export const Config: Schema<Config> = Schema.object({
  bridge: Schema.object({ mode: Schema.union(['live', 'mock']).default('live'), origin: Schema.string().default('http://127.0.0.1:8787'), tokenEnv: Schema.string().default('AGENT_BRIDGE_CONTROL_TOKEN'), token: Schema.string().role('secret'), timeoutMs: Schema.number().min(100).default(15000) }).required(),
  kanban: Schema.object({ mode: Schema.union(['sidecar', 'ssh', 'http', 'mock']).default('sidecar'), board: Schema.string().default('default'), permissionMode: Schema.union(['read-only', 'orchestrator', 'operator']).default('orchestrator'), author: Schema.string().default('dsh-orchestrator'), hermesRoot: Schema.string().default('/root/.hermes/hermes-agent'), hermesHome: Schema.string().default('/root/.hermes'), python: Schema.string().default('python3'), sshCommand: Schema.string().default('ssh'), sshHost: Schema.string(), remoteScript: Schema.string(), baseUrl: Schema.string(), tokenEnv: Schema.string(), timeoutMs: Schema.number().min(100).default(15000) }).required(),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' { interface Context { agentControl: AgentControlService } }
interface ConnectionFace {
  rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, options: { authority: 'trusted-host' | 'loopback' }): () => Promise<void> }
  fetch: { register(route: { path: string; methods: readonly ('GET' | 'HEAD' | 'POST')[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
}

type RpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'bad-request' | 'internal'; message: string; details: Record<string, unknown> } }

export function createAgentControlRpcHandler(service: AgentControlService) {
  return async (_endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> => {
    try {
      const body = payload as Partial<DashboardRequest>
      if ((body.domain !== 'overview' && body.domain !== 'bridge' && body.domain !== 'kanban') || typeof body.operation !== 'string') {
        throw new ControlError('invalid_parameter', 'domain and operation are required.', 400)
      }
      const value = await service.dispatch({
        domain: body.domain,
        operation: body.operation,
        ...(body.args ? { args: body.args } : {}),
      }, signal)
      return { ok: true, value }
    } catch (error) {
      // Connection validates a closed transport error union. Agent Control's
      // domain codes (for example bridge_unavailable) belong in the message,
      // never in the transport discriminator.
      const response = errorResponse(error)
      return {
        ok: false,
        error: {
          code: response.status === 400 ? 'bad-request' : 'internal',
          message: await response.text(),
          details: {},
        },
      }
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  const service = new AgentControlService(config)
  ctx.provide('agentControl', service)
  ctx.effect(() => () => { service.dispose() }, 'agent-control: service lifecycle')
  registerAgentBridgeProvider(ctx, service)
  registerTools(ctx, service)
  ctx.systemPrompt.section({ name: 'tool:agent-control', order: 2650, text: [
    'Agent Control orchestration rules:',
    '- Use Agent Bridge directly for short questions or immediate continuation of an external session.',
    '- Create a Hermes Kanban task for durable tracking, dependencies, review, or work spanning multiple turns.',
    '- Resolve assignees from real Bridge workers or Hermes profiles; never invent an assignee.',
    '- You may create and observe tasks, but external agent output alone is not proof that a task is complete.',
    '- Agent Bridge sessions and Kanban tasks may be associated, but they are distinct sources of truth.',
    '- Worker-only Kanban lifecycle operations complete/block/heartbeat are intentionally unavailable.',
  ].join('\n') })
  ctx.on('tools/pre-execute', async (execution, next) => MUTATING_TOOL_NAMES.has(execution.name)
    ? { kind: 'ask', reason: `${execution.name} changes external Agent Bridge or Hermes state.` }
    : next())
  // Register through the dependency-scoped fiber, matching DSH's built-in
  // plugins. This makes channel lifetime and hot reload disposal deterministic.
  ctx.inject(['connection'], (scoped) => {
    const connection = Reflect.get(scoped, 'connection') as ConnectionFace
    scoped.effect(
      () => connection.rpc.handle(AGENT_CONTROL_RPC_CHANNEL, createAgentControlRpcHandler(service), { authority: 'trusted-host' }),
      'agent-control: rpc channel',
    )
    scoped.effect(
      () => connection.fetch.register({
        path: AGENT_CONTROL_STREAM_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: request => service.bridge.stream(new URL(request.url).searchParams.get('cursor') ?? undefined, request.signal),
      }),
      'agent-control: Bridge SSE proxy',
    )
  })
}
