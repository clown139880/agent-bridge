import type { ReactNode } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

export type ExternalChatEventProps =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'command'; command: string; status?: string; output?: string; exitCode?: number }
  | { kind: 'file-change'; changes: readonly unknown[]; summary?: string; truncated?: boolean }

/** Preview stand-in. The installed product uses the actual DSH Chat components. */
export function ExternalChatEvent(props: ExternalChatEventProps): ReactNode {
  if (props.kind === 'user') return <div data-external-chat-event="user" data-native-message="user">{props.text}</div>
  if (props.kind === 'assistant') return <div data-external-chat-event="assistant" data-native-message="assistant"><MarkdownText text={props.text} labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Notes' }} /></div>
  if (props.kind === 'command') {
    return <details data-external-chat-event="command" data-native-command><summary>{props.command} · {props.status} · Exit {props.exitCode ?? 'unknown'}</summary><pre>{props.output}</pre></details>
  }
  return <details data-external-chat-event="file-change" data-native-file-change><summary>File changes · {props.changes.length}{props.truncated ? ' (truncated)' : ''}</summary><pre>{props.summary ?? JSON.stringify(props.changes, null, 2)}</pre></details>
}
