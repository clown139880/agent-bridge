import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentControlService } from '../service.js'
import type { JsonObject } from '../types.js'
import type { AgentBridgeImportTarget } from './import-target.js'
import { readHistory } from './import-target.js'
import { lastUserMessageId, lastUserText, parentItemId, projectStreamChunks, PROVIDER, record, sameUserText, str, TOOL_EVENT_TYPES, toolProgressLine } from './mapping.js'
import { relayPendingInteractions } from './approval-bridge.js'
import { uploadPromptImages } from './attachments.js'

export const AGENT_BRIDGE_PROVIDER = PROVIDER
export { toolProgressLine }
/**
 * Whether an aborted local turn was stopped by someone (Stop, a cancelling
 * parent) rather than torn down with the Host. A Desktop restart or plugin
 * reload must leave the remote turn running; the next sync shows its output.
 */
export function stoppedByUser(reason: unknown): boolean {
  if (record(reason)['kind'] === 'disposed') return false
  return !(reason instanceof Error && /lifecycle disposed|agent loop is not active/.test(reason.message))
}
export class AgentBridgeLlmAdapter extends LlmAdapter {
  constructor(private readonly service: AgentControlService, private readonly target: AgentBridgeImportTarget, private readonly pollMs = 600) { super() }
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Agent Bridge' } }
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return [{ provider: PROVIDER, id: 'remote', name: 'Follow remote session', inputModalities: ['text', 'image'] }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model, inputModalities: ['text', 'image'] } }
  servesAgent(agent: Agent): boolean { return !!this.target.binding(String(agent.id)) }
  attachAgent(_agent: Agent): void {}
  detachAgent(_id: unknown): void {}

  /**
   * One remote turn as one native turn. The remote work has already run, so
   * nothing here is a local tool call: each batch of remote output is written
   * into the native turn as it arrives (texts, tool cards, subagent cards), in
   * arrival order. Only the reply that ends the turn goes through this stream,
   * so it is the native turn's own answer and lands below everything before it.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.sessionId || options.purpose) throw new Error('Agent Bridge supports bound conversation turns only')
    const nativeId = String(options.sessionId)
    const binding = this.target.binding(nativeId)
    if (!binding) throw new Error('This DSH session is not bound to a Bridge session')
    const agent = this.target.host.agents.get(nativeId)
    if (!agent) throw new Error('Bridge session has no native Agent')
    let remoteId = str(binding['sessionId'])
    const signal = options.signal ?? new AbortController().signal
    let input = lastUserText(options)
    const localMessageId = lastUserMessageId(options)
    const attachments = await uploadPromptImages(options, agent, this.service.bridge, signal)
    if (!input.trim() && !attachments.length) throw new Error('Bridge requires text or an image')
    if (!input.trim()) input = '[Image attached]'
    this.target.setBusy(nativeId, true)
    const interactionAbort = new AbortController()
    const interactionSignal = AbortSignal.any([signal, interactionAbort.signal])
    const pending = new Map<string, Promise<void>>()
    let receipt: JsonObject = {}
    let turnId = ''
    // The latest reply not yet followed by other output. A later item shows it
    // first; if the turn ends on it, it is the answer this stream returns.
    let reply: JsonObject | undefined
    try {
      let cursor: string | undefined
      const seen = new Set<string>()
      let expectedTurnId = ''
      // Native provider catalogs are not remote model catalogs.
      const model = options.provider === PROVIDER && options.model !== 'remote' ? options.model : undefined
      if (!remoteId) {
        // A draft's first message creates its Bridge session; that session has no
        // earlier history to skip. create_session takes no reasoning effort.
        receipt = await this.target.createDraftRemote(nativeId, { input, ...(model ? { model } : {}), ...(attachments.length ? { attachments } : {}) }, signal)
        remoteId = str(receipt['sessionId'])
      } else {
        const baseline = await readHistory(this.service.bridge, remoteId, undefined, signal)
        cursor = baseline.cursor
        for (const row of baseline.rows) seen.add(str(row['eventId']))
        const session = record(await this.service.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, signal))
        expectedTurnId = ['active', 'waiting_for_approval', 'waiting_for_input'].includes(str(session['status'])) ? str(session['activeTurnId']) : ''
        const args: JsonObject = { sessionId: remoteId, input, delivery: 'auto', ...(expectedTurnId ? { expectedTurnId } : {}) }
        if (attachments.length) args['attachments'] = attachments
        if (!expectedTurnId && model) args['model'] = model
        if (!expectedTurnId && options.reasoningEffort) args['reasoningEffort'] = options.reasoningEffort
        receipt = record(await this.service.bridge.call({ operation: 'submit_turn', args }, signal))
      }
      let finished = false
      let buffered: JsonObject[] = []
      while (!finished) {
        signal.throwIfAborted()
        if (receipt['status'] === 'accepted') receipt = record(await this.service.bridge.call({ operation: 'action', args: { actionId: str(receipt['actionId']) } }, signal))
        if (['failed', 'cancelled', 'expired'].includes(str(receipt['status']))) throw new Error('Bridge action ' + str(receipt['status']) + ': ' + JSON.stringify(receipt['error'] ?? {}))
        turnId = str(receipt['turnId'], turnId || expectedTurnId)
        if (receipt['status'] === 'succeeded' && !turnId) throw new Error('Bridge action succeeded without a turn identity; cannot safely attribute its output')
        const page = await readHistory(this.service.bridge, remoteId, cursor, signal)
        cursor = page.cursor
        for (const row of page.rows) if (!seen.has(str(row['eventId']))) { seen.add(str(row['eventId'])); buffered.push(row) }
        if (turnId) {
          const ready = buffered.filter(row => row['turnId'] === turnId)
          buffered = buffered.filter(row => row['turnId'] !== turnId)
          const batch: JsonObject[] = []
          let failure: JsonObject | undefined
          for (const row of ready) {
            const payload = record(row['payload'])
            const type = str(row['type'])
            if (type === 'message.completed' && payload['role'] === 'user' && sameUserText(str(payload['text']), input)) {
              // The prompt typed here is already on screen; only its echo is recorded.
              this.target.acknowledge(nativeId, [localMessageId ? { ...row, localMessageId } : row])
            } else if (type === 'message.completed' && payload['role'] === 'assistant' && str(payload['text'])) {
              if (reply) batch.push(reply)
              reply = row
            } else if (type === 'message.completed' || ((TOOL_EVENT_TYPES.includes(type) || type === 'task.completed') && !parentItemId(row))) {
              if (reply) { batch.push(reply); reply = undefined }
              batch.push(row)
            } else if (TOOL_EVENT_TYPES.includes(type)) {
              // A subagent's step: recorded now, listed on its card when it ends.
              batch.push(row)
            }
            if (type === 'turn.failed' || (type === 'turn.completed' && payload['status'] === 'failed')) { failure = payload; break }
            if (type === 'turn.completed' || type === 'turn.interrupted') finished = true
          }
          this.target.presentLive(nativeId, batch)
          if (failure) throw new Error('Bridge turn failed: ' + JSON.stringify(failure))
          if (!finished) await relayPendingInteractions(this.service.bridge, agent, remoteId, pending, interactionSignal, this.target.host as unknown as Context)
          if (!finished && receipt['status'] === 'succeeded') {
            const current = record(await this.service.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, signal))
            if (current['status'] === 'offline' || current['status'] === 'error') throw new Error('Bridge session became ' + str(current['status']))
            // Some workers report session state without a retained turn.completed event.
            if (!current['activeTurnId'] && current['status'] === 'idle') {
              const finalPage = await readHistory(this.service.bridge, remoteId, cursor, signal)
              const newRows = finalPage.rows.filter(row => !seen.has(str(row['eventId'])))
              for (const row of newRows) { seen.add(str(row['eventId'])); buffered.push(row) }
              cursor = finalPage.cursor
              if (!newRows.length) finished = true
            }
          }
        }
        if (!finished) await delay(this.pollMs, undefined, { signal })
      }
      if (reply) {
        const answer = reply
        reply = undefined
        this.target.acknowledge(nativeId, [answer])
        for (const chunk of projectStreamChunks(answer)) yield chunk
      }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { actionId: str(receipt['actionId']), turnId } } }
    } finally {
      // Stopped or failed before the turn ended: the reply so far still shows, in
      // the step the native loop is about to close.
      if (reply) {
        try { this.target.presentLive(nativeId, [reply]) }
        catch (error) { this.target.host.logger.warn('Bridge reply could not be shown: ' + String(error)) }
      }
      interactionAbort.abort()
      await Promise.allSettled(pending.values())
      this.target.setBusy(nativeId, false)
      if (signal.aborted && turnId && stoppedByUser(signal.reason)) {
        try { await this.service.bridge.call({ operation: 'interrupt_turn', args: { sessionId: remoteId, expectedTurnId: turnId } }) }
        catch (error) { this.target.host.logger.warn('Bridge cancellation could not be confirmed: ' + String(error)) }
      }
    }
  }
}
