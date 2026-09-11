import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentControlService } from '../service.js'
import type { JsonObject } from '../types.js'
import type { AgentBridgeImportTarget } from './import-target.js'
import { readHistory } from './import-target.js'
import { lastUserText, projectStreamChunks, PROVIDER, record, str } from './mapping.js'
import { relayPendingInteractions } from './approval-bridge.js'

export const AGENT_BRIDGE_PROVIDER = PROVIDER
export class AgentBridgeLlmAdapter extends LlmAdapter {
  readonly pendingAcks = new Map<string, JsonObject[]>()
  constructor(private readonly service: AgentControlService, private readonly target: AgentBridgeImportTarget, private readonly pollMs = 600) { super() }
  providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Agent Bridge' } }
  override async listModels(): Promise<readonly LlmModelInfo[]> {
    return [{ provider: PROVIDER, id: 'remote', name: 'Follow remote session' }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }
  servesAgent(agent: Agent): boolean { return !!this.target.binding(String(agent.id)) }
  attachAgent(_agent: Agent): void {}
  detachAgent(id: unknown): void { this.pendingAcks.delete(String(id)) }
  commitAcks(id: string): void {
    const rows = this.pendingAcks.get(id)
    if (rows) { this.target.acknowledge(id, rows); this.pendingAcks.delete(id) }
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
    const input = lastUserText(options)
    if (!input.trim()) throw new Error('Bridge requires a text prompt')
    // Image/file admission cannot silently discard content that the native composer accepted.
    const lastUser = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user')
    if (lastUser?.content.some(block => block.type !== 'text')) throw new Error('Bridge attachment forwarding is not available for this native session yet')
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
      const expectedTurnId = str(session['activeTurnId'])
      const args: JsonObject = { sessionId: remoteId, input, delivery: 'auto', ...(expectedTurnId ? { expectedTurnId } : {}) }
      // Native provider catalogs are not remote model catalogs.
      if (!expectedTurnId && options.provider === PROVIDER && options.model !== 'remote') args['model'] = options.model
      if (!expectedTurnId && options.reasoningEffort) args['reasoningEffort'] = options.reasoningEffort
      receipt = record(await this.service.bridge.call({ operation: 'submit_turn', args }, signal))
      let index = 0
      let finished = false
      const buffered: JsonObject[] = []
      this.pendingAcks.set(nativeId, [])
      while (!finished) {
        signal.throwIfAborted()
        if (receipt['status'] === 'accepted') receipt = record(await this.service.bridge.call({ operation: 'action', args: { actionId: str(receipt['actionId']) } }, signal))
        if (['failed', 'cancelled', 'expired'].includes(str(receipt['status']))) throw new Error('Bridge action ' + str(receipt['status']) + ': ' + JSON.stringify(receipt['error'] ?? {}))
        turnId = str(receipt['turnId'], turnId || expectedTurnId)
        const page = await readHistory(this.service.bridge, remoteId, cursor, signal)
        cursor = page.cursor
        for (const row of page.rows) if (!seen.has(str(row['eventId']))) { seen.add(str(row['eventId'])); buffered.push(row) }
        if (turnId) {
          for (const row of buffered.splice(0)) {
            if (row['turnId'] !== turnId) continue
            const payload = record(row['payload'])
            if (row['type'] === 'message.completed') {
              if (payload['role'] === 'user' && payload['text'] === input) this.pendingAcks.get(nativeId)!.push(row)
              else if (payload['role'] === 'assistant') {
                for (const chunk of projectStreamChunks(row, index)) yield chunk
                index++
                this.pendingAcks.get(nativeId)!.push(row)
              }
            }
            if (row['type'] === 'turn.failed' || (row['type'] === 'turn.completed' && payload['status'] === 'failed')) throw new Error('Bridge turn failed: ' + JSON.stringify(payload))
            if (row['type'] === 'turn.completed' || row['type'] === 'turn.interrupted') finished = true
          }
          await relayPendingInteractions(this.service.bridge, agent, remoteId, pending, interactionSignal)
          if (!finished && receipt['status'] === 'succeeded') {
            const current = record(await this.service.bridge.call({ operation: 'session', args: { sessionId: remoteId } }, signal))
            if (current['status'] === 'offline' || current['status'] === 'error') throw new Error('Bridge session became ' + str(current['status']))
            // Some workers report session state without a retained turn.completed event.
            if (!current['activeTurnId'] && current['status'] === 'idle') {
              const finalPage = await readHistory(this.service.bridge, remoteId, cursor, signal)
              if (finalPage.rows.length) { buffered.push(...finalPage.rows.filter(row => !seen.has(str(row['eventId'])))); cursor = finalPage.cursor }
              else finished = true
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
