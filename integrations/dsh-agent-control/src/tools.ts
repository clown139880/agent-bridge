import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { AgentControlService } from './service.js'
import type { JsonObject, JsonValue } from './types.js'

const id = (description: string) => ({ type: 'string' as const, required: true as const, description })
const optionalString = (description: string) => ({ type: 'string' as const, description })
const json = (description: string) => ({ type: 'json' as const, description })
interface ToolSpec { name: string; description: string; parameters: ParameterSchemaSpec; domain: 'bridge' | 'kanban'; operation: string; mutates?: boolean }

export const TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'agent_bridge_list_workers', description: 'List real Agent Bridge workers and their online state, capabilities, and workspaces.', parameters: {}, domain: 'bridge', operation: 'workers' },
  { name: 'agent_bridge_snapshot', description: 'Get a consistent worker/session/pending-request snapshot.', parameters: { sessionLimit: { type: 'integer' } }, domain: 'bridge', operation: 'snapshot' },
  { name: 'agent_bridge_list_sessions', description: 'List external agent sessions. These are references, not DSH native Sessions.', parameters: { workerId: optionalString('Worker id'), status: optionalString('Session status'), workspace: optionalString('Workspace path'), taskId: optionalString('Associated Kanban task id'), limit: { type: 'integer' }, cursor: optionalString('Opaque cursor') }, domain: 'bridge', operation: 'sessions' },
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
  { name: 'hermes_kanban_list', description: 'List tasks from the configured real Hermes board, grouped by lifecycle column.', parameters: {}, domain: 'kanban', operation: 'list' },
  { name: 'hermes_kanban_show', description: 'Show a task with comments, dependency links, events, runs, and result.', parameters: { taskId: id('Kanban task id') }, domain: 'kanban', operation: 'show' },
  { name: 'hermes_kanban_assignees', description: 'List real Hermes profiles/assignees. Never invent one.', parameters: {}, domain: 'kanban', operation: 'assignees' },
  { name: 'hermes_kanban_create', description: 'Create a durable task on the configured Hermes board.', parameters: { title: id('Task title'), body: optionalString('Task specification'), assignee: optionalString('Real assignee'), priority: { type: 'integer' }, workspaceKind: { type: 'string', enum: ['scratch', 'worktree', 'dir'] }, workspacePath: optionalString('Absolute path'), parents: { type: 'array', items: { type: 'string' } }, triage: { type: 'boolean' }, maxRuntimeSeconds: { type: 'integer' }, skills: { type: 'array', items: { type: 'string' } }, goalMode: { type: 'boolean' }, goalMaxTurns: { type: 'integer' }, modelOverride: optionalString('Configured model'), reasoningEffort: optionalString('Configured reasoning level'), idempotencyKey: optionalString('Stable idempotency key') }, domain: 'kanban', operation: 'create', mutates: true },
  { name: 'hermes_kanban_comment', description: 'Append a durable comment to a task.', parameters: { taskId: id('Task id'), body: id('Comment') }, domain: 'kanban', operation: 'comment', mutates: true },
  { name: 'hermes_kanban_link_dependency', description: 'Link parent to child using Hermes dependency validation.', parameters: { parentId: id('Parent id'), childId: id('Child id') }, domain: 'kanban', operation: 'link', mutates: true },
  { name: 'hermes_kanban_request_review', description: 'Request review through Hermes lifecycle rules; not completion proof.', parameters: { taskId: id('Task id'), summary: id('Review summary'), reviewer: optionalString('Real reviewer'), force: { type: 'boolean', description: 'Explicit operator override; normally false' } }, domain: 'kanban', operation: 'request_review', mutates: true },
  { name: 'hermes_kanban_request_changes', description: 'Return an active review run with required changes.', parameters: { taskId: id('Task id'), reason: id('Required changes'), expectedRunId: { type: 'integer' } }, domain: 'kanban', operation: 'request_changes', mutates: true },
  { name: 'hermes_kanban_unblock', description: 'Operator-only: re-gate a blocked task through Hermes rules.', parameters: { taskId: id('Task id') }, domain: 'kanban', operation: 'unblock', mutates: true },
  { name: 'hermes_kanban_reassign', description: 'Operator-only: reassign a non-running task.', parameters: { taskId: id('Task id'), assignee: optionalString('Real profile or omit'), reason: optionalString('Audit reason') }, domain: 'kanban', operation: 'reassign', mutates: true },
  { name: 'hermes_kanban_reclaim', description: 'Operator-only: reclaim an active task through Hermes rules.', parameters: { taskId: id('Task id'), reason: optionalString('Audit reason') }, domain: 'kanban', operation: 'reclaim', mutates: true },
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
