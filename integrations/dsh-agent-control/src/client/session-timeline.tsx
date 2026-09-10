import { MarkdownText, TerminalBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels, TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import * as ChatUi from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComponentType } from 'react'
import type { JsonObject } from '../types.js'
import { asArray, asRecord, projectEvents, str } from './session-model.js'
import css from './workspace.module.css'

const markdownLabels: MarkdownLabels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Notes' }
const terminalLabels: TerminalBlockLabels = {
  signal: signal => `Signal ${signal}`, exitCode: code => `Exit ${code}`, running: 'Running', failed: 'Failed', done: 'Done',
  copy: 'Copy', copied: 'Copied', noOutput: 'No output retained', collapseAria: 'Collapse command output', collapse: 'Collapse',
  expandAria: count => `Show ${count} hidden lines`, expand: count => `Show ${count} more lines`,
}
type ExternalChatEventProps =
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'command'; command: string; status?: string; output?: string; exitCode?: number }
  | { kind: 'file-change'; changes: readonly unknown[]; summary?: string; truncated?: boolean }
const ExternalChatEvent = (ChatUi as unknown as { ExternalChatEvent?: ComponentType<ExternalChatEventProps> }).ExternalChatEvent
export function eventTime(timestamp: unknown): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
function imageMarker(payload: JsonObject) {
  const attachments = asArray(payload['attachments'])
  if (!attachments.length) return null
  return <p className={css.plainMessage} aria-label="attached images">🖼 {attachments.length} image{attachments.length > 1 ? 's' : ''} attached</p>
}
function EventBody({ event, summaryOnly }: { event: JsonObject; summaryOnly: boolean }) {
  const payload = asRecord(event['payload'])
  const type = str(event['type'])
  if (ExternalChatEvent && type === 'message.completed') {
    const role = payload['role'] === 'user' ? 'user' : 'assistant'
    return <>{<ExternalChatEvent kind={role} text={str(payload['text'], '')} />}{imageMarker(payload)}</>
  }
  if (ExternalChatEvent && type === 'command.completed') {
    const exitCode = payload['exitCode']
    return <ExternalChatEvent kind="command" command={str(payload['command'])} status={str(payload['status'], 'completed')} output={str(payload['output'], '')} {...(typeof exitCode === 'number' ? { exitCode } : {})} />
  }
  if (ExternalChatEvent && type === 'file_change.completed') {
    return <ExternalChatEvent kind="file-change" changes={asArray(payload['changes'])} {...(typeof payload['summary'] === 'string' ? { summary: payload['summary'] } : {})} {...(payload['truncated'] === true ? { truncated: true } : {})} />
  }
  if (ExternalChatEvent && type === 'turn.failed') {
    return <ExternalChatEvent kind="error" message={str(payload['error'], str(payload['summary'], 'Turn failed'))} {...(typeof payload['code'] === 'string' ? { code: payload['code'] } : {})} />
  }
  if (type === 'message.completed') return <div className={css.messageBody} data-role={str(payload['role'])}>
    <strong className={css.messageRole}>{str(payload['role'])}</strong>
    {payload['role'] === 'assistant' ? <MarkdownText text={str(payload['text'], '')} labels={markdownLabels} /> : <p className={css.plainMessage}>{str(payload['text'], '')}</p>}
    {imageMarker(payload)}
  </div>
  if (type === 'command.completed') return <details className={css.commandDetails}>
    <summary><code>{str(payload['command'])}</code><span> · {str(payload['status'], 'Settled')} · Exit {str(payload['exitCode'], 'unknown')}</span></summary>
    {typeof payload['exitCode'] === 'number' ? <TerminalBlock command={str(payload['command'])} cwd={str(payload['cwd'], '')} output={str(payload['output'], '')} exitCode={payload['exitCode']} labels={terminalLabels} /> : <pre>{str(payload['output'], 'No output retained')}</pre>}
  </details>
  if (type === 'file_change.completed') return <details className={css.commandDetails}>
    <summary>File changes · {asArray(payload['changes']).length}{payload['truncated'] === true ? ' (truncated)' : ''}</summary>
    {typeof payload['summary'] === 'string' && <p>{payload['summary']}</p>}
    {asArray(payload['changes']).map((value, index) => { const change = asRecord(value); return <div key={index}><strong>{str(change['path'], str(change['file'], 'Change'))}</strong><pre>{str(change['diff'], str(change['patch'], JSON.stringify(value, null, 2)))}</pre></div> })}
  </details>
  if (type.startsWith('turn.')) return <div className={css.turnStatus}><strong>{type.replace('turn.', 'Turn ')}</strong>{typeof payload['error'] === 'string' && <p>{payload['error']}</p>}{typeof payload['summary'] === 'string' && payload['summary'] && (summaryOnly ? <div className={css.messageBody} data-role="assistant"><strong className={css.messageRole}>Turn summary</strong><MarkdownText text={payload['summary']} labels={markdownLabels} /></div> : <details><summary>Turn summary</summary><MarkdownText text={payload['summary']} labels={markdownLabels} /></details>)}</div>
  if (type === 'progress') return <p className={css.plainMessage}>{str(payload['summary'])}</p>
  if (type.startsWith('approval.') || type.startsWith('user_input.')) return <p className={css.plainMessage}>{type.replaceAll('_', ' ').replace('.', ' · ')} · {str(asRecord(payload['approval'] ?? payload['request'])['summary'], 'Interaction recorded')}</p>
  return <details><summary>{type} · View event</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
}
export function SessionTimeline({ events, raw }: { events: JsonObject[]; raw: boolean }) {
  const projected = raw ? events : projectEvents(events)
  const messageTurns = new Set(events.filter(event => event['type'] === 'message.completed' && asRecord(event['payload'])['role'] === 'assistant').map(event => event['turnId']))
  let previousTurn: string | undefined
  return <>{projected.map(event => {
    const turn = str(event['turnId'], 'Session activity')
    const newTurn = turn !== previousTurn; previousTurn = turn
    return <article className={css.transcriptEvent} key={str(event['eventId'])} data-event-id={str(event['eventId'])}>
      {raw && newTurn && <div className={css.turnHeading}>{turn}</div>}
      <time className={css.eventTime}>{eventTime(event['timestamp'])}</time>
      {raw ? <pre>{JSON.stringify(event, null, 2)}</pre> : <EventBody event={event} summaryOnly={!messageTurns.has(event['turnId'])} />}
    </article>
  })}</>
}
