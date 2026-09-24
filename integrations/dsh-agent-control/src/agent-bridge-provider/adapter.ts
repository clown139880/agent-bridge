import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentControlService } from '../service.js'
import type { JsonObject } from '../types.js'
import type { AgentBridgeImportTarget } from './import-target.js'
import { readHistory } from './import-target.js'
import { lastUserText, PROVIDER, record, str } from './mapping.js'
import { relayPendingInteractions } from './approval-bridge.js'
import { uploadPromptImages } from './attachments.js'

export const AGENT_BRIDGE_PROVIDER = PROVIDER
interface PendingTurn {
  acknowledgements: JsonObject[]
  presentations: JsonObject[]
}
export class AgentBridgeLlmAdapter extends LlmAdapter {
  readonly pendingAcks = new Map<string, PendingTurn[]>()
  constructor(private readonly service: AgentControlService, private readonly target: AgentBridgeImportTarget, private readonly pollMs = 600) { super() }
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Agent Bridge' } }
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return [{ provider: PROVIDER, id: 'remote', name: 'Follow remote session', inputModalities: ['text', 'image'] }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model, inputModalities: ['text', 'image'] } }
  servesAgent(agent: Agent): boolean { return !!this.target.binding(String(agent.id)) }
  attachAgent(_agent: Agent): void {}
  detachAgent(id: unknown): void { this.pendingAcks.delete(String(id)) }
  commitAcks(id: string): void {
    const batches = this.pendingAcks.get(id)
    const batch = batches?.shift()
    if (batch) this.target.finalizeNativeTurn(id, batch.acknowledgements, batch.presentations)
    if (!batches?.length) this.pendingAcks.delete(id)
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.sessionId || options.purpose) throw new Error('Agent Bridge supports bound conversation turns only')
    const nativeId = String(options.sessionId)
    const binding = this.target.binding(nativeId)
    if (!binding) throw new Error('This DSH session is not bound to a Bridge session')
    const agent = this.target.host.agents.get(nativeId)
    if (!agent) throw new Error('Bridge session has no native Agent')
    const remoteId = str(binding['sessionId'])
    const signal = options.signal ?? new AbortController().signal
    let input = lastUserText(options)
    const attachments = await uploadPromptImages(options, agent, this.service.bridge, signal)
    if (!input.trim() && !attachments.length) throw new Error('Bridge requires text or an image')
    if (!input.trim()) input = '[Image attached]'
    this.target.setBusy(nativeId, true)
    const interactionAbort = new AbortController()
    const interactionSignal = AbortSignal.any([signal, interactionAbort.signal])
    const pending = new Map<string, Promise<void>>()
    let receipt: JsonObject = {}
    let turnId = ''
    try {
      const baseline = await readHistory(this.service.bridge, remoteId, undefined, signal)
      let cursor = baseline.cursor
      const seen = new Set(baseline.rows.map(row => str(row['eventId'])))
      const session = record(await this.service.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, signal))
      const expectedTurnId = ['active', 'waiting_for_approval', 'waiting_for_input'].includes(str(session['status'])) ? str(session['activeTurnId']) : ''
      const args: JsonObject = { sessionId: remoteId, input, delivery: 'auto', ...(expectedTurnId ? { expectedTurnId } : {}) }
      if (attachments.length) args['attachments'] = attachments
      // Native provider catalogs are not remote model catalogs.
      if (!expectedTurnId && options.provider === PROVIDER && options.model !== 'remote') args['model'] = options.model
      if (!expectedTurnId && options.reasoningEffort) args['reasoningEffort'] = options.reasoningEffort
      receipt = record(await this.service.bridge.call({ operation: 'submit_turn', args }, signal))
      let finished = false
      let buffered: JsonObject[] = []
      const ackRows: JsonObject[] = []
      const presentationRows: JsonObject[] = []
      const emitted = new Set<string>()
      let nextBlockIndex = 0
      const ackBatches = this.pendingAcks.get(nativeId) ?? []
      ackBatches.push({ acknowledgements: ackRows, presentations: presentationRows })
      this.pendingAcks.set(nativeId, ackBatches)
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
          for (const row of ready) {
            const payload = record(row['payload'])
            if (row['type'] === 'message.completed') {
              if (payload['role'] === 'user' && payload['text'] === input) ackRows.push(row)
            }
            // Only assistant text goes through the native LLM stream. Remote tools have
            // already executed, so finalizeNativeTurn appends display-only tool events
            // after the local turn closes instead of returning executable tool chunks.
            const rendered = row['type'] === 'message.completed' && payload['role'] === 'assistant' ? str(payload['text']) : ''
            if (rendered) {
              const key = str(row['itemId'], str(row['eventId']))
              if (!emitted.has(key)) {
                emitted.add(key)
                const index = nextBlockIndex++
                yield { type: 'block-start', index, blockType: 'text' }
                yield { type: 'text-delta', index, text: rendered }
                yield { type: 'block-end', index, block: { type: 'text', text: rendered } }
              }
              ackRows.push(row)
            }
            if (['command.completed', 'file_change.completed', 'tool.completed'].includes(str(row['type']))) presentationRows.push(row)
            if (row['type'] === 'turn.failed' || (row['type'] === 'turn.completed' && payload['status'] === 'failed')) throw new Error('Bridge turn failed: ' + JSON.stringify(payload))
            if (row['type'] === 'turn.completed' || row['type'] === 'turn.interrupted') finished = true
          }
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
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { actionId: str(receipt['actionId']), turnId } } }
    } finally {
      interactionAbort.abort()
      await Promise.allSettled(pending.values())
      this.target.setBusy(nativeId, false)
      if (signal.aborted && turnId) {
        try { await this.service.bridge.call({ operation: 'interrupt_turn', args: { sessionId: remoteId, expectedTurnId: turnId } }) }
        catch (error) { this.target.host.logger.warn('Bridge cancellation could not be confirmed: ' + String(error)) }
      }
    }
  }
}
