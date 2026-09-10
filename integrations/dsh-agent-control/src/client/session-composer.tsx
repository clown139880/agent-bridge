import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import * as ConversationUi from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useLayoutEffect, useRef } from 'react'
import type { ComponentType, HTMLAttributes, ReactNode } from 'react'
import type { JsonObject } from '../types.js'
import { str } from './session-model.js'
import css from './workspace.module.css'

export interface DraftImage { filename: string; mimeType: string; base64: string }
const IMAGE_MIME_ALLOWLIST = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const IMAGE_ACCEPT = IMAGE_MIME_ALLOWLIST.join(',')

function readImageFile(file: File): Promise<DraftImage | undefined> {
  if (!IMAGE_MIME_ALLOWLIST.includes(file.type)) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onerror = () => resolve(undefined)
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const base64 = result.slice(result.indexOf(',') + 1)
      resolve(base64 ? { filename: file.name || 'image', mimeType: file.type, base64 } : undefined)
    }
    reader.readAsDataURL(file)
  })
}
async function emitImages(files: Iterable<File>, onAddImage: (image: DraftImage) => void): Promise<void> {
  for (const file of files) { const image = await readImageFile(file); if (image) onAddImage(image) }
}

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

interface ComposerProps {
  value: string; busy: boolean; canSend: boolean; active: boolean
  attachments: JsonObject[]
  modelControl?: ReactNode; onChange(value: string): void; onSend(): void; onStop(): void
  onAddImage(image: DraftImage): void; onRemoveAttachment(id: string): void
  context?: { usedTokens: number; contextWindow: number }
}

/** Bridge action adapter. DSH's full Lexical composer requires native session/queue bindings. */
export function SessionComposer(props: ComposerProps) {
  const { value, busy, canSend, active, modelControl, context, onChange, onSend, onStop } = props
  const ExternalComposer = (ConversationUi as unknown as { ExternalComposer?: ExternalComposerFace }).ExternalComposer
  // Note: the package ExternalComposer is not exported at runtime today; images
  // are handled entirely in CompatibleSessionComposer below.
  if (ExternalComposer) return <ExternalComposer {...{
    value, busy, disabled: !canSend, running: active,
    placeholder: active ? 'Steer this conversation…' : 'Message this conversation…',
    ariaLabel: 'Message to selected session', modelControl,
    ...(context ? { context } : {}),
    onChange, onSubmit: onSend, onStop,
  }} />

  return <CompatibleSessionComposer {...props} />
}

function CompatibleSessionComposer({ value, busy, canSend, active, attachments, modelControl, onChange, onSend, onStop, onAddImage, onRemoveAttachment }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const hasContent = Boolean(value.trim()) || attachments.length > 0
  const enabled = canSend && !busy && hasContent
  const primaryStops = active && !hasContent
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
    }} onPaste={canSend ? event => {
      const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((f): f is File => Boolean(f))
      if (files.length) { event.preventDefault(); void emitImages(files, onAddImage) }
    } : undefined} onDrop={canSend ? event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault(); void emitImages(event.dataTransfer.files, onAddImage)
    } : undefined} onDragOver={canSend ? event => event.preventDefault() : undefined}>
      {attachments.length > 0 && <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '4px 0' }} aria-label="Attached images">
        {attachments.map(item => {
          const id = str(item['id']); const preview = str(item['previewUrl'])
          return <span key={id} style={{ position: 'relative', display: 'inline-flex' }}>
            {preview ? <img src={preview} alt={str(item['filename'], 'image')} style={{ height: '48px', width: '48px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--dsh-border, #3334)' }} />
              : <span style={{ padding: '4px 8px', fontSize: '12px' }}>{str(item['filename'], 'image')}</span>}
            <Button size="sm" type="button" aria-label={`Remove ${str(item['filename'], 'image')}`} title="Remove" onClick={() => onRemoveAttachment(id)}
              style={{ position: 'absolute', top: '-6px', right: '-6px', minWidth: '18px', height: '18px', padding: 0, lineHeight: '18px', borderRadius: '9px' }}>×</Button>
          </span>
        })}
      </div>}
      <textarea ref={input} rows={1} aria-label="Message to selected session" aria-describedby="bridge-composer-hint" value={value} disabled={busy}
        onChange={event => onChange(event.target.value)} placeholder={active ? 'Steer this conversation…' : 'Message this conversation…'}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
          event.preventDefault()
          if (enabled) event.currentTarget.form?.requestSubmit()
        }} />
      <div className={css.composerBottom}><span id="bridge-composer-hint">{!canSend ? 'Read-only' : busy ? <><span className={css.sendSpinner} aria-hidden="true" /> Sending…</> : 'Shift+Enter for newline'}</span>{modelControl}
        <input ref={picker} type="file" accept={IMAGE_ACCEPT} multiple style={{ display: 'none' }}
          onChange={event => { const files = event.target.files; if (files?.length) void emitImages(files, onAddImage); event.target.value = '' }} />
        <Button size="sm" type="button" className={css.footerButton} disabled={!canSend || busy} aria-label="Attach image" title="Attach image" onClick={() => picker.current?.click()}>
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" fill="none" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </Button>
        <Button type={primaryStops ? 'button' : 'submit'} variant="primary" className={css.sendButton} disabled={primaryStops ? busy || !canSend : !enabled} aria-label={busy ? 'Sending message' : primaryStops ? 'Stop' : 'Send'} title={primaryStops ? 'Interrupt active turn' : active ? 'Send to active turn' : 'Send message'} onClick={primaryStops ? onStop : undefined}>{busy ? <span className={css.sendSpinner} aria-hidden="true" /> : <svg aria-hidden="true" viewBox="0 0 16 16">{primaryStops ? <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" stroke="none" /> : <path d="M8 12.5v-9m0 0L4.5 7M8 3.5 11.5 7" />}</svg>}</Button>
      </div>
    </form>
  </ComposerSurface></div>
}
