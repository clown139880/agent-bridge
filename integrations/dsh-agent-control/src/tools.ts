import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { AgentControlService } from './service.js'
import type { JsonObject, JsonValue } from './types.js'

const id = (description: string) => ({ type: 'string' as const, required: true as const, description })
const optionalString = (description: string) => ({ type: 'string' as const, description })
const json = (description: string) => ({ type: 'json' as const, description })
interface ToolSpec { name: string; description: string; parameters: ParameterSchemaSpec; domain: 'bridge'; operation: string; mutates?: boolean }

export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'agent_bridge_list_workers', description: 'List real Agent Bridge workers and their online state, capabilities, and workspaces.', parameters: {}, domain: 'bridge', operation: 'workers' },
  { name: 'agent_bridge_snapshot', description: 'Get a consistent worker/session/pending-request snapshot.', parameters: { sessionLimit: { type: 'integer' } }, domain: 'bridge', operation: 'snapshot' },
  { name: 'agent_bridge_list_sessions', description: 'List external agent sessions. These are references, not DSH native Sessions.', parameters: { workerId: optionalString('Worker id'), status: optionalString('Session status'), workspace: optionalString('Workspace path'), taskId: optionalString('Associated task id'), limit: { type: 'integer' }, cursor: optionalString('Opaque cursor') }, domain: 'bridge', operation: 'sessions' },
  { name: 'agent_bridge_get_session', description: 'Get one external agent session and its associations.', parameters: { sessionId: id('External session id') }, domain: 'bridge', operation: 'session' },
  { name: 'agent_bridge_get_events', description: 'Read structured events for an external agent session.', parameters: { sessionId: id('External session id'), after: optionalString('Opaque event cursor'), limit: { type: 'integer' }, type: optionalString('Optional event type') }, domain: 'bridge', operation: 'session_events' },
  { name: 'agent_bridge_create_session', description: 'Create a session on a real listed worker, optionally starting its first turn.', parameters: { workerId: id('Worker id returned by list workers'), workspace: id('Absolute workspace returned by that worker'), input: optionalString('Optional first-turn input'), model: optionalString('Optional configured Codex model') }, domain: 'bridge', operation: 'create_session', mutates: true },
  { name: 'agent_bridge_submit_turn', description: 'Continue an external session using server-resolved auto/steer/start semantics.', parameters: { sessionId: id('External session id'), input: id('Non-empty turn input'), delivery: { type: 'string', enum: ['auto', 'steer', 'start_turn'] }, expectedTurnId: optionalString('Current turn id for concurrency protection'), model: optionalString('Optional configured Codex model; only for a new turn'), reasoningEffort: optionalString('Optional Codex reasoning effort; only for a new turn') }, domain: 'bridge', operation: 'submit_turn', mutates: true },
  { name: 'agent_bridge_interrupt_turn', description: 'Interrupt the active turn of an external session.', parameters: { sessionId: id('External session id'), expectedTurnId: optionalString('Current turn id for concurrency protection') }, domain: 'bridge', operation: 'interrupt_turn', mutates: true },
  { name: 'agent_bridge_list_approvals', description: 'List pending or resolved external agent approvals.', parameters: { sessionId: optionalString('External session id'), status: optionalString('Status'), limit: { type: 'integer' }, cursor: optionalString('Opaque cursor') }, domain: 'bridge', operation: 'approvals' },
  { name: 'agent_bridge_resolve_approval', description: 'Respond to an external approval using one of its advertised choices.', parameters: { approvalId: id('Approval id'), choice: id('Advertised stable choice') }, domain: 'bridge', operation: 'resolve_approval', mutates: true },
  { name: 'agent_bridge_list_user_input', description: 'List structured user-input requests. Secret answers may require local handling.', parameters: { sessionId: optionalString('External session id'), status: optionalString('Status'), limit: { type: 'integer' }, cursor: optionalString('Opaque cursor') }, domain: 'bridge', operation: 'user_input' },
  { name: 'agent_bridge_respond_user_input', description: 'Submit structured answers. Unsafe secret relay returns secret_input_unsupported.', parameters: { requestId: id('User-input request id'), answers: json('Map of question id to {answers:string[]}') }, domain: 'bridge', operation: 'respond_user_input', mutates: true },
  { name: 'agent_bridge_get_action', description: 'Get a previously accepted asynchronous Bridge action.', parameters: { actionId: id('Action id') }, domain: 'bridge', operation: 'action' },
]

export const MUTATING_TOOL_NAMES = new Set(TOOL_SPECS.filter(item => item.mutates).map(item => item.name))
export function registerTools(ctx: Context, service: AgentControlService): void {
  for (const spec of TOOL_SPECS) ctx.tools.register(defineTool({
    name: spec.name, description: spec.description, parameters: spec.parameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec): Promise<JsonValue> {
      return service.dispatch({ domain: spec.domain, operation: spec.operation, args: args as JsonObject }, exec.signal)
    },
  }))
}
