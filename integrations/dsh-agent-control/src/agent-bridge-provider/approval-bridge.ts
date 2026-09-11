import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { BridgeClient } from '../bridge-client.js'
import type { JsonObject } from '../types.js'
import { record, str } from './mapping.js'

export function bridgeApprovalToRequest(bridge: JsonObject): Pick<ApprovalRequestEvent, 'toolName' | 'reason'> {
  return { toolName: str(bridge['toolName'], 'agent-bridge:action'), reason: str(bridge['summary'], 'Approve this remote action?') }
}
export function bridgeUserInputToQuestions(bridge: JsonObject): AskUserQuestionItem[] {
  const raw = Array.isArray(bridge['questions']) ? bridge['questions'] : []
  return raw.map(value => {
    const item = record(value)
    if (item['isSecret'] === true) throw new Error('Secret Bridge questions require a secure worker-side input surface')
    const id = str(item['id'])
    if (!id) throw new Error('Bridge question has no id')
    const options = Array.isArray(item['options']) ? item['options'].map(value => {
      const option = record(value)
      return { label: str(option['label']), ...(str(option['description']) ? { description: str(option['description']) } : {}) }
    }) : []
    return { id, question: str(item['question']), ...(str(item['header']) ? { header: str(item['header']) } : {}), ...(options.length ? { options } : {}) }
  })
}
export function bridgeUserInputRequest(bridge: JsonObject): Omit<AskUserQuestionRequestEvent, 'agent' | 'signal'> {
  return { questions: bridgeUserInputToQuestions(bridge) }
}
export function userInputAnswerToBridge(bridge: JsonObject, answer: AskUserQuestionAnswer): JsonObject {
  const allowed = new Set(bridgeUserInputToQuestions(bridge).map(question => question.id))
  const answers: JsonObject = {}
  for (const item of answer.answers) {
    if (!allowed.has(item.id)) throw new Error('Answer contains an unknown question')
    answers[item.id] = { answers: [...item.selected, ...(item.custom ? [item.custom] : [])] }
  }
  return { requestId: str(bridge['id']), answers }
}

async function pendingRows(bridge: Pick<BridgeClient, 'call'>, operation: 'approvals' | 'user_input', sessionId: string, signal: AbortSignal): Promise<JsonObject[]> {
  const rows: JsonObject[] = []
  const seen = new Set<string>()
  let cursor = ''
  do {
    const page = record(await bridge.call({ operation, args: { sessionId, status: 'pending', limit: 200, ...(cursor ? { cursor } : {}) } }, signal))
    if (!Array.isArray(page['data'])) throw new Error('Invalid Bridge pending page')
    for (const value of page['data']) {
      const row = record(value)
      if (row['sessionId'] !== sessionId) throw new Error('Cross-session pending interaction')
      if (row['status'] === 'pending') rows.push(row)
    }
    if (!page['hasMore']) return rows
    const next = str(page['nextCursor'])
    if (!next || seen.has(next)) throw new Error('Pending cursor did not advance')
    seen.add(next); cursor = next
  } while (true)
}

/** Polling never awaits the human. Each pending id has one scoped, cancellable native request. */
export async function relayPendingInteractions(bridge: Pick<BridgeClient, 'call'>, agent: Agent, remoteId: string,
  jobs: Map<string, Promise<void>>, signal: AbortSignal): Promise<void> {
  const [approvals, questions] = await Promise.all([
    pendingRows(bridge, 'approvals', remoteId, signal), pendingRows(bridge, 'user_input', remoteId, signal),
  ])
  for (const [kind, rows] of [['approval', approvals], ['question', questions]] as const) for (const row of rows) {
    const key = kind + ':' + str(row['id'])
    if (jobs.has(key)) continue
    const run = async () => {
      if (kind === 'approval') {
        const choices = Array.isArray(row['choices']) ? row['choices'].map(value => str(value)).filter(Boolean) : []
        let choice = ''
        if (agent.status === 'running' && choices.length === 2 && choices.includes('allow') && choices.includes('deny')) {
          const outcome = await agent.ctx.approval.request({ agent, signal, ...bridgeApprovalToRequest(row) })
          if (outcome === 'allowed-once') choice = 'allow'
          else if (outcome === 'rejected') choice = 'deny'
          else return // cancellation/unavailable must not become an external decision
        } else {
          const answer = await agent.ctx.userQuestions.ask({ agent, signal, questions: [{ id: 'decision', question: str(row['summary'], 'Remote approval'), options: choices.map(label => ({ label })) }] })
          choice = answer.answers.find(item => item.id === 'decision')?.selected[0] ?? ''
          if (!choices.includes(choice)) throw new Error('Select an advertised Bridge approval choice')
        }
        signal.throwIfAborted()
        const current = record(await bridge.call({ operation: 'approval', args: { approvalId: str(row['id']) } }, signal))
        if (current['status'] === 'pending') await bridge.call({ operation: 'resolve_approval', args: { approvalId: str(row['id']), choice } }, signal)
      } else {
        const answer = await agent.ctx.userQuestions.ask({ agent, signal, ...bridgeUserInputRequest(row) })
        signal.throwIfAborted()
        const current = record(await bridge.call({ operation: 'user_input_request', args: { requestId: str(row['id']) } }, signal))
        if (current['status'] === 'pending') await bridge.call({ operation: 'respond_user_input', args: userInputAnswerToBridge(row, answer) }, signal)
      }
    }
    jobs.set(key, run().catch(error => { if (!signal.aborted) agent.ctx.logger.warn('Bridge interaction: ' + String(error)) }))
  }
}
