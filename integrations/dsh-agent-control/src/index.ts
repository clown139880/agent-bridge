import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ControlError, errorResponse } from './errors.js'
import { AgentControlService, type AgentControlConfig } from './service.js'
import { MUTATING_TOOL_NAMES, registerTools } from './tools.js'
import type { DashboardRequest, DashboardResponse } from './types.js'

export * from './bridge-client.js'
export * from './errors.js'
export * from './kanban-client.js'
export * from './service.js'
export * from './types.js'
export { MUTATING_TOOL_NAMES, TOOL_SPECS } from './tools.js'
export const name = 'agent-control'
export const inject = ['tools', 'systemPrompt', 'connection']
export const AGENT_CONTROL_PATH = '/api/agent-control'
export interface Config extends AgentControlConfig {}

export const Config: Schema<Config> = Schema.object({
  bridge: Schema.object({ mode: Schema.union(['live', 'mock']).default('live'), origin: Schema.string().default('http://127.0.0.1:8787'), tokenEnv: Schema.string().default('AGENT_BRIDGE_CONTROL_TOKEN'), token: Schema.string().role('secret'), timeoutMs: Schema.number().min(100).default(15000) }).required(),
  kanban: Schema.object({ mode: Schema.union(['sidecar', 'http', 'mock']).default('sidecar'), board: Schema.string().default('default'), permissionMode: Schema.union(['read-only', 'orchestrator', 'operator']).default('orchestrator'), author: Schema.string().default('dsh-orchestrator'), hermesRoot: Schema.string().default('/root/.hermes/hermes-agent'), hermesHome: Schema.string().default('/root/.hermes'), python: Schema.string().default('python3'), baseUrl: Schema.string(), tokenEnv: Schema.string(), timeoutMs: Schema.number().min(100).default(15000) }).required(),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' { interface Context { agentControl: AgentControlService } }
interface ConnectionFace { fetch: { register(route: { path: string; methods: readonly 'POST'[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> } }

export function apply(ctx: Context, config: Config): void {
  const service = new AgentControlService(config)
  ctx.provide('agentControl', service)
  ctx.effect(() => () => { service.dispose() }, 'agent-control: service lifecycle')
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
  const connection = Reflect.get(ctx, 'connection') as ConnectionFace
  connection.fetch.register({ path: AGENT_CONTROL_PATH, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
    try {
      const length = Number(request.headers.get('content-length') ?? '0')
      if (length > 1_048_576) return errorResponse(new ControlError('body_too_large', 'Request body exceeds 1 MiB.', 413))
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ ok: false, error: { code: 'unsupported_media_type', message: 'Use application/json.', status: 415 } } satisfies DashboardResponse, { status: 415 })
      const body = await request.json() as Partial<DashboardRequest>
      if ((body.domain !== 'overview' && body.domain !== 'bridge' && body.domain !== 'kanban') || typeof body.operation !== 'string') return Response.json({ ok: false, error: { code: 'invalid_parameter', message: 'domain and operation are required.', status: 400 } } satisfies DashboardResponse, { status: 400 })
      const data = await service.dispatch({ domain: body.domain, operation: body.operation, ...(body.args ? { args: body.args } : {}) }, request.signal)
      return Response.json({ ok: true, data } satisfies DashboardResponse, { headers: { 'cache-control': 'no-store' } })
    } catch (error) { return errorResponse(error) }
  } })
}
