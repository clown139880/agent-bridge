import { forwardRef } from 'react'
import type { HTMLAttributes, ReactNode, UIEventHandler } from 'react'

/** Test/preview stand-in for the public DSH composer surface. */
export function ComposerSurface({ children, ...props }: HTMLAttributes<HTMLDivElement> & { workspaceTrigger?: boolean }) {
  const { workspaceTrigger: _workspaceTrigger, ...rest } = props
  return <div {...rest} data-composer-card>{children}</div>
}

/** Contract stand-in; the installed DSH implementation owns the real Lexical editor and CSS. */
export function ExternalComposer({ value, onChange, onSubmit, onStop, running = false, disabled = false, busy = false, placeholder, ariaLabel, modelControl, context }: {
  value: string; disabled?: boolean; busy?: boolean; running?: boolean; placeholder?: string; ariaLabel?: string
  modelControl?: import('react').ReactNode
  context?: { usedTokens: number; contextWindow: number }
  onChange(value: string): void; onSubmit(): void; onStop?(): void
}) {
  const primaryStops = running && !value.trim()
  const sendDisabled = disabled || busy || (primaryStops ? !onStop : !value.trim())
  return <div data-external-composer><textarea value={value} disabled={disabled || busy} placeholder={placeholder} aria-label={ariaLabel}
    onChange={event => onChange(event.target.value)} onKeyDown={event => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return
      event.preventDefault()
      if (!sendDisabled) onSubmit()
    }} />
  {modelControl}{context && <span aria-label="Context used">{Math.round(context.usedTokens / context.contextWindow * 100)}%</span>}<button type="button" aria-label={busy ? 'Sending message' : primaryStops ? 'Stop' : 'Send'} disabled={sendDisabled} onClick={primaryStops ? onStop : onSubmit}>{primaryStops ? 'Stop' : 'Send'}</button></div>
}

/** Preview/test stand-in for DSH's resident external conversation shell. */
export const ExternalConversationSurface = forwardRef<HTMLDivElement, { title: string; subtitle?: ReactNode; headerActions?: ReactNode; children?: ReactNode; composer?: ReactNode; overlay?: ReactNode; className?: string; scrollAriaLabel?: string; onScroll?: UIEventHandler<HTMLDivElement> }>(function ExternalConversationSurface({ title, subtitle, headerActions, children, composer, overlay, className, scrollAriaLabel, onScroll }, ref) {
  return <div className={className} data-external-conversation data-phase="active"><header><div><strong>{title}</strong>{headerActions}</div>{subtitle}</header><div data-conversation-body><div ref={ref} data-conversation-scroll aria-label={scrollAriaLabel} onScroll={onScroll}><div data-conversation-view>{children}</div><div data-composer-seat>{composer}</div></div>{overlay}</div></div>
})
