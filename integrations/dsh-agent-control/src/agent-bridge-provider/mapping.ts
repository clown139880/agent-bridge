import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonObject, JsonValue } from '../types.js'
import type { NativeEvent } from './dsh-compat.js'

export const PROVIDER = 'agent-bridge'
export const BINDING_EVENT = 'agent-bridge/binding'
export const ACK_EVENT = 'agent-bridge/event'
export const record = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
export const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
export function textFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}
export function lastUserText(options: GenerateOptions): string {
  const user = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user')
    ?? [...options.messages].reverse().find(message => message.role === 'user')
  return user ? textFromBlocks(user.content) : ''
}
/** Only assistant text goes to the loop. Remote tools have already executed. */
export function projectStreamChunks(event: JsonObject, index = 0): StreamChunk[] {
  const payload = record(event['payload'])
  if (event['type'] !== 'message.completed' || payload['role'] !== 'assistant') return []
  const text = str(payload['text'])
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

/** Balanced presentation transactions; never put remote tool calls in the local execution queue. */
export function projectNativeEvents(rows: readonly JsonObject[], existing: readonly NativeEvent[], model = 'remote'): NativeEvent[] {
  const seen = new Set(existing.filter(e => e.type === ACK_EVENT).map(e => str(e.data['eventId'])))
  let turn = existing.reduce((n, e) => Math.max(n, Number(e.data['turn']) || 0), 0)
  const output: NativeEvent[] = []
  const add = (type: string, data: JsonObject, time: number, surface = false) => {
    output.push({ type, data, seq: existing.length + output.length, time, ...(surface ? { surfaceOp: 'append' as const } : {}) })
  }
  // Backfilled transcript prompts carry their original timestamp.
  const ordered = existing.some(e => e.type === 'user/message' || e.type === 'assistant/message') ? rows : [...rows].sort((a, b) => Number(a['timestamp']) - Number(b['timestamp']))
  for (const row of ordered) {
    const id = str(row['eventId'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    const payload = record(row['payload'])
    const type = str(row['type'])
    const time = typeof row['timestamp'] === 'number' ? row['timestamp'] : Date.now()
    const isMessage = type === 'message.completed' && ['user', 'assistant'].includes(str(payload['role']))
    const isTool = ['command.completed', 'file_change.completed', 'tool.completed'].includes(type)
    if (isMessage || isTool) {
      turn++
      add('turn/start', { turn }, time)
      add('step/start', { turn, step: 1 }, time)
      if (isMessage && payload['role'] === 'user') {
        const recovered = payload['recoveredFirstPrompt'] === true && existing.some(e => e.type === 'assistant/message')
        add('user/message', { id: 'bridge:' + id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: (recovered ? '【恢复的首条用户消息】\n' : '') + str(payload['text']) }] }, time, true)
      } else {
        const callId = 'bridge:' + str(row['itemId'], id)
        const name = type === 'command.completed' ? 'agent-bridge:command' : type === 'file_change.completed' ? 'agent-bridge:files' : 'agent-bridge:tool'
        const args = JSON.stringify(type === 'command.completed' ? { command: payload['command'], cwd: payload['cwd'] } : payload)
        const text = str(payload['text'])
        const content: JsonValue[] = isTool ? [{ type: 'tool-call', id: callId, name, arguments: args }] : [{ type: 'text', text }]
        add('assistant/message', { turn, step: 1, message: { id: 'bridge:' + id + ':assistant', role: 'assistant', source: { kind: 'model', provider: PROVIDER, model }, content }, stream: [] }, time, true)
        if (isTool) {
          add('tool/call', { turn, step: 1, callId, name, arguments: args }, time)
          add('tool/result', { turn, step: 1, message: { id: 'bridge:' + id + ':result', role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: str(payload['output'], JSON.stringify(payload)) }], isError: payload['status'] === 'failed' }] } }, time, true)
        }
      }
      add('step/end', { turn, step: 1 }, time)
      add('turn/end', { turn, reason: { kind: 'completed' } }, time)
    }
    add(ACK_EVENT, { eventId: id, turnId: str(row['turnId']) }, time)
  }
  return output
}
