import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonObject, JsonValue } from '../types.js'
import { toolResultMessage, type NativeEvent, type ToolResultShape } from './dsh-compat.js'

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

/** Remote tool events presented as tool cards. */
export const TOOL_EVENT_TYPES: readonly string[] = ['command.completed', 'file_change.completed', 'tool.completed']
/** A tool call made by a subagent or background task rather than the main conversation. */
export const parentItemId = (row: JsonObject): string => str(record(row['payload'])['parentItemId'])

const TASK_ENDINGS: Record<string, string> = { completed: '完成', failed: '失败', killed: '已终止', stopped: '已停止', lost: '中断' }
const taskLabel = (payload: JsonObject) => {
  const kind = str(payload['kind'])
  const who = kind === 'agent' ? '子代理' + (str(payload['subagentType']) ? ' ' + str(payload['subagentType']) : '') : kind === 'monitor' ? '监视' : '后台任务'
  return who + (str(payload['description']) ? '：' + str(payload['description']) : '')
}

/** One recognisable line per remote tool: an icon for its kind, then what it touched. */
export function toolProgressLine(row: JsonObject): string {
  const payload = record(row['payload'])
  const failed = payload['status'] === 'failed' ? '❌ ' : ''
  const short = (text: string) => { const first = text.trim().split('\n')[0] ?? ''; return first.length > 160 ? first.slice(0, 159) + '…' : first }
  if (row['type'] === 'command.completed') return failed + '💻 ' + short(str(payload['command'], 'command'))
  if (row['type'] === 'file_change.completed') {
    const paths = (Array.isArray(payload['changes']) ? payload['changes'] : []).map(change => str(record(change)['path'])).filter(Boolean)
    return failed + '✏️ ' + (paths.length ? paths.join(', ') : str(payload['summary'], 'file change'))
  }
  if (row['type'] === 'task.started') return '🤖 ' + short(taskLabel(payload)) + ' · 开始'
  if (row['type'] === 'task.completed') {
    const status = str(payload['status'])
    return (status === 'completed' ? '' : '❌ ') + '🤖 ' + short(taskLabel(payload)) + ' · ' + (TASK_ENDINGS[status] ?? status)
  }
  return failed + '🔧 ' + short(str(payload['summary'], str(payload['name'], 'tool')))
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

/** The turn and step a running native loop has open. */
export interface OpenStep { turn: number; step: number }

/**
 * The turn and step a running native loop has open, or undefined when the log
 * is balanced. Read back from the log, so it names the turn as written (see
 * guardImportedTurnNumbers), which is what DSH's session invariants check.
 */
export function openStep(events: readonly NativeEvent[]): OpenStep | undefined {
  let turn: number | undefined
  let step: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') { turn = Number(event.data['turn']); step = undefined }
    else if (event.type === 'turn/end') { turn = undefined; step = undefined }
    else if (event.type === 'step/start') step = Number(event.data['step'])
    else if (event.type === 'step/end') step = undefined
  }
  return turn !== undefined && step !== undefined ? { turn, step } : undefined
}

/**
 * Balanced presentation transactions; never put remote tool calls in the local execution queue.
 * Without `into`, each item is its own closed turn: the log must be balanced (no
 * native turn running). With `into`, items join the running native loop's open
 * turn and step, so they show while the turn runs; DSH's invariants forbid
 * opening a turn inside another.
 */
export function projectNativeEvents(rows: readonly JsonObject[], existing: readonly NativeEvent[], model = 'remote', toolResult: ToolResultShape = 'tool-role', into?: OpenStep): NativeEvent[] {
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
  // A subagent's steps arrive before its end, possibly in an earlier sync. Each
  // is acknowledged with its one-line summary, which its task card lists once it ends.
  const steps = new Map<string, string[]>()
  const addStep = (parent: string, line: string) => { const lines = steps.get(parent); if (lines) lines.push(line); else steps.set(parent, [line]) }
  for (const e of acknowledgements) if (str(e.data['parentItemId']) && str(e.data['step'])) addStep(str(e.data['parentItemId']), str(e.data['step']))
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
    const isTask = type === 'task.completed'
    const isTool = TOOL_EVENT_TYPES.includes(type) || isTask
    const parent = parentItemId(row)
    if (isTool && parent && !isTask) {
      const line = toolProgressLine(row)
      addStep(parent, line)
      add(ACK_EVENT, { eventId: id, turnId: str(row['turnId']), parentItemId: parent, step: line }, time)
      continue
    }
    if (isMessage || isTool) {
      if (!into) {
        turn++
        add('turn/start', { turn }, time)
        add('step/start', { turn, step: 1 }, time)
      }
      const at = into ?? { turn, step: 1 }
      if (isMessage && payload['role'] === 'user') {
        const recovered = payload['recoveredFirstPrompt'] === true && existing.some(e => e.type === 'assistant/message')
        add('user/message', { id: 'bridge:' + id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: (recovered ? '【恢复的首条用户消息】\n' : '') + str(payload['text']) }] }, time, true)
      } else {
        const callId = 'bridge:' + id
        // DSH counts a `subagent` call as a subagent in the turn summary.
        const name = type === 'command.completed' ? 'agent-bridge:command' : type === 'file_change.completed' ? 'agent-bridge:files'
          : isTask ? (payload['kind'] === 'agent' ? 'subagent' : 'agent-bridge:task') : 'agent-bridge:tool'
        const args = JSON.stringify(type === 'command.completed' ? { command: payload['command'], cwd: payload['cwd'] }
          : isTask ? { description: payload['description'] ?? '', ...(payload['subagentType'] ? { subagentType: payload['subagentType'] } : {}), kind: payload['kind'] ?? 'other' } : payload)
        const text = str(payload['text'])
        const content: JsonValue[] = isTool ? [{ type: 'tool-call', id: callId, name, arguments: args }] : [{ type: 'text', text }]
        add('assistant/message', { ...at, message: { id: 'bridge:' + id + ':assistant', role: 'assistant', source: { kind: 'model', provider: PROVIDER, model }, content }, stream: [] }, time, true)
        if (isTool) {
          add('tool/call', { ...at, callId, name, arguments: args }, time)
          // The seed validator's tool/result shape depends on the DSH release; see ToolResultShape.
          const taskSteps = isTask ? steps.get(str(row['itemId'])) ?? [] : []
          const output = isTask ? taskOutput(payload, taskSteps) : str(payload['output'], JSON.stringify(payload))
          const isError = isTask ? payload['status'] !== 'completed' : payload['status'] === 'failed'
          add('tool/result', { ...at, message: toolResultMessage('bridge:' + id + ':result', callId, output, isError, toolResult) }, time, true)
        }
      }
      if (!into) {
        add('step/end', { turn, step: 1 }, time)
        add('turn/end', { turn, reason: { kind: 'completed' } }, time)
      }
    }
    add(ACK_EVENT, { eventId: id, turnId: str(row['turnId']) }, time)
  }
  return output
}

/** A task card's result: what the task reported, then the steps it took. */
function taskOutput(payload: JsonObject, steps: readonly string[]): string {
  const report = str(payload['result'], str(payload['summary'], TASK_ENDINGS[str(payload['status'])] ?? str(payload['status'])))
  return steps.length ? report + '\n\n' + steps.length + ' 个步骤：\n' + steps.join('\n') : report
}

function messageText(content: unknown): string {
  return Array.isArray(content) ? content.map(block => record(block)['type'] === 'text' ? str(record(block)['text']) : '').join('') : ''
}

/** Treat pre-canonical history ids as the same App Server item as their live ids. */
function presentationItemKey(eventId: string): string | undefined {
  const match = /^app-server:[^:]+:(?:[^:]+:)?([^:]+):(history-)?(message|command|file-change)$/.exec(eventId)
  return match ? `${match[3]}:${match[1]}` : undefined
}
