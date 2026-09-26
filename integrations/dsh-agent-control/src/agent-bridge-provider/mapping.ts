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
/** The DSH message a live turn submitted, so its remote echo can name what it answers. */
export function lastUserMessageId(options: GenerateOptions): string {
  const user = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user')
  return str((user as { id?: unknown } | undefined)?.id)
}

/**
 * Whether a remote user echo is the prompt typed locally. Workers shorten long
 * echoes (`…`, or `\n…[truncated]`) and replace an image-only prompt with a
 * placeholder, so strict equality misses exactly the prompts that then show twice.
 */
export function sameUserText(remote: string, local: string): boolean {
  const echo = remote.trim()
  const typed = local.trim()
  if (echo === typed) return true
  if (echo === '[Image attached]' && !typed) return true
  const cut = /(?:\n…\[truncated\]|…)$/.exec(echo)
  return !!cut && echo.length > cut[0].length && typed.startsWith(echo.slice(0, cut.index).trim())
}

/**
 * A remote echo pairs with a local prompt only if the worker recorded it around
 * when DSH sent it: a little earlier for clock skew between machines, and up to
 * hours later — a prompt sent during a running turn is queued and echoed, under
 * the next turn's id, only once that turn ends.
 */
const echoesLocal = (echoAt: number, sentAt: number) => echoAt >= sentAt - 2 * 60 * 1000 && echoAt <= sentAt + 6 * 60 * 60 * 1000

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
  const acknowledgements = existing.filter(e => e.type === ACK_EVENT)
  const seen = new Set(acknowledgements.map(e => str(e.data['eventId'])))
  const seenItems = new Set([...seen].map(presentationItemKey).filter((key): key is string => !!key))
  const submittedUserTurns = new Set(acknowledgements.filter(e => /^action:[^:]+:user$/.test(str(e.data['eventId']))).map(e => str(e.data['turnId'])))
  // Prompts typed in DSH are already on screen. Their remote echo must not be
  // shown again even when the live turn never recorded it — a restart, crash or
  // failure mid-turn skips that — so each echo claims one unclaimed local prompt.
  const claimed = new Set(acknowledgements.map(e => str(e.data['localMessageId'])).filter(Boolean))
  const localPrompts = existing.filter(e => e.type === 'user/message' && record(e.data['source'])['kind'] === 'user'
    && !str(e.data['id']).startsWith('bridge:') && !claimed.has(str(e.data['id'])))
  let turn = existing.reduce((n, e) => Math.max(n, Number(e.data['turn']) || 0), 0)
  const output: NativeEvent[] = []
  const add = (type: string, data: JsonObject, time: number, surface = false) => {
    output.push({ type, data, seq: existing.length + output.length, time, ...(surface ? { surfaceOp: 'append' as const } : {}) })
  }
  // Backfilled transcript prompts carry their original timestamp.
  const ordered = existing.some(e => e.type === 'user/message' || e.type === 'assistant/message') ? rows : [...rows].sort((a, b) => Number(a['timestamp']) - Number(b['timestamp']))
  for (const row of ordered) {
    const id = str(row['eventId'])
    const itemKey = presentationItemKey(id)
    if (!id || seen.has(id) || (itemKey ? seenItems.has(itemKey) : false)) continue
    seen.add(id)
    if (itemKey) seenItems.add(itemKey)
    const payload = record(row['payload'])
    const type = str(row['type'])
    if (type === 'message.completed' && payload['role'] === 'user' && submittedUserTurns.has(str(row['turnId']))) continue
    const time = typeof row['timestamp'] === 'number' ? row['timestamp'] : Date.now()
    if (type === 'message.completed' && payload['role'] === 'user') {
      const local = localPrompts.find(e => !claimed.has(str(e.data['id'])) && echoesLocal(time, e.time)
        && sameUserText(str(payload['text']), messageText(e.data['content'])))
      if (local) {
        claimed.add(str(local.data['id']))
        add(ACK_EVENT, { eventId: id, turnId: str(row['turnId']), localMessageId: str(local.data['id']) }, time)
        continue
      }
    }
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
        const callId = 'bridge:' + id
        const name = type === 'command.completed' ? 'agent-bridge:command' : type === 'file_change.completed' ? 'agent-bridge:files' : 'agent-bridge:tool'
        const args = JSON.stringify(type === 'command.completed' ? { command: payload['command'], cwd: payload['cwd'] } : payload)
        const text = str(payload['text'])
        const content: JsonValue[] = isTool ? [{ type: 'tool-call', id: callId, name, arguments: args }] : [{ type: 'text', text }]
        add('assistant/message', { turn, step: 1, message: { id: 'bridge:' + id + ':assistant', role: 'assistant', source: { kind: 'model', provider: PROVIDER, model }, content }, stream: [] }, time, true)
        if (isTool) {
          add('tool/call', { turn, step: 1, callId, name, arguments: args }, time)
          // A tool/result message must carry role "tool", a top-level toolCallId
          // matching source.callId, and model-facing content blocks. DSH 0.1.7-rc.2
          // dropped the "tool-result" content block type and now validates this
          // shape at the seed boundary, so the result text goes in a plain text
          // block with the tool-call linkage lifted to the message envelope.
          add('tool/result', { turn, step: 1, message: { id: 'bridge:' + id + ':result', role: 'tool', toolCallId: callId, isError: payload['status'] === 'failed', source: { kind: 'tool', callId }, content: [{ type: 'text', text: str(payload['output'], JSON.stringify(payload)) }] } }, time, true)
        }
      }
      add('step/end', { turn, step: 1 }, time)
      add('turn/end', { turn, reason: { kind: 'completed' } }, time)
    }
    add(ACK_EVENT, { eventId: id, turnId: str(row['turnId']) }, time)
  }
  return output
}

function messageText(content: unknown): string {
  return Array.isArray(content) ? content.map(block => record(block)['type'] === 'text' ? str(record(block)['text']) : '').join('') : ''
}

/** Treat pre-canonical history ids as the same App Server item as their live ids. */
function presentationItemKey(eventId: string): string | undefined {
  const match = /^app-server:[^:]+:(?:[^:]+:)?([^:]+):(history-)?(message|command|file-change)$/.exec(eventId)
  return match ? `${match[3]}:${match[1]}` : undefined
}
