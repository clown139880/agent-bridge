import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import * as ConversationUi from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useLayoutEffect, useRef } from 'react'
import type { ComponentType, HTMLAttributes, ReactNode } from 'react'
import css from './workspace.module.css'

type ComposerSurfaceFace = ComponentType<HTMLAttributes<HTMLDivElement> & { workspaceTrigger?: boolean }>
type ExternalComposerFace = ComponentType<{
  value: string; busy?: boolean; disabled?: boolean; running?: boolean; placeholder?: string; ariaLabel?: string; className?: string; modelControl?: ReactNode
  onChange(value: string): void; onSubmit(): void; onStop?(): void
  context?: { usedTokens: number; contextWindow: number }
}>
const ComposerSurface = (ConversationUi as unknown as { ComposerSurface?: ComposerSurfaceFace }).ComposerSurface
  ?? function CompatibleComposerSurface({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div {...props} data-composer-card>{children}</div>
  }

/** Bridge action adapter. DSH's full Lexical composer requires native session/queue bindings. */
export function SessionComposer({ value, busy, canSend, active, modelControl, context, onChange, onSend, onStop }: {
  value: string; busy: boolean; canSend: boolean; active: boolean
  modelControl?: ReactNode; onChange(value: string): void; onSend(): void; onStop(): void
  context?: { usedTokens: number; contextWindow: number }
}) {
  const ExternalComposer = (ConversationUi as unknown as { ExternalComposer?: ExternalComposerFace }).ExternalComposer
  if (ExternalComposer) return <ExternalComposer {...{
    value, busy, disabled: !canSend, running: active,
    placeholder: active ? 'Steer this conversation…' : 'Message this conversation…',
    ariaLabel: 'Message to selected session', modelControl,
    ...(context ? { context } : {}),
    onChange, onSubmit: onSend, onStop,
  }} />

  return <CompatibleSessionComposer value={value} busy={busy} canSend={canSend} active={active} modelControl={modelControl} onChange={onChange} onSend={onSend} onStop={onStop} />
}

function CompatibleSessionComposer({ value, busy, canSend, active, modelControl, onChange, onSend, onStop }: {
  value: string; busy: boolean; canSend: boolean; active: boolean
  modelControl?: ReactNode; onChange(value: string): void; onSend(): void; onStop(): void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const enabled = canSend && !busy && Boolean(value.trim())
  const primaryStops = active && !value.trim()
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(336, Math.max(24, element.scrollHeight))}px`
  }, [value])
  return <div className={css.bridgeComposerSeat} data-composer-seat><ComposerSurface className={css.bridgeComposerSurface} data-bridge-composer aria-label="Bridge message composer">
    <form className={css.composerForm} onSubmit={event => {
      event.preventDefault()
      if (enabled) onSend()
    }}>
      <textarea ref={input} rows={1} aria-label="Message to selected session" aria-describedby="bridge-composer-hint" value={value} disabled={busy}
        onChange={event => onChange(event.target.value)} placeholder={active ? 'Steer this conversation…' : 'Message this conversation…'}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
          event.preventDefault()
          if (enabled) event.currentTarget.form?.requestSubmit()
        }} />
      <div className={css.composerBottom}><span id="bridge-composer-hint">{!canSend ? 'Read-only' : busy ? 'Sending…' : 'Shift+Enter for newline'}</span>{modelControl}
        <Button type={primaryStops ? 'button' : 'submit'} variant="primary" className={css.sendButton} disabled={primaryStops ? busy || !canSend : !enabled} aria-label={busy ? 'Sending message' : primaryStops ? 'Stop' : 'Send'} title={primaryStops ? 'Interrupt active turn' : active ? 'Send to active turn' : 'Send message'} onClick={primaryStops ? onStop : undefined}><svg aria-hidden="true" viewBox="0 0 16 16">{primaryStops ? <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" stroke="none" /> : <path d="M8 12.5v-9m0 0L4.5 7M8 3.5 11.5 7" />}</svg></Button>
      </div>
    </form>
  </ComposerSurface></div>
}
