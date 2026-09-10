// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The pinned dev dependency (0.1.2-rc.1) does not export `ExternalComposer`, so
// the branch that broke input on newer clients is never exercised by the real
// package. Stub a faithful native composer — its own `[data-composer-seat]`,
// a controlled contenteditable-equivalent — to reproduce and guard the seat
// contract without a live 0.1.3 client.
vi.mock('@deepseek-ai/dsh-client-ui-conversation/client', () => ({
  ComposerSurface: undefined,
  ExternalComposer: ({ value, disabled, placeholder, ariaLabel, modelControl, onChange, onSubmit }: {
    value: string; disabled?: boolean; placeholder?: string; ariaLabel?: string; modelControl?: unknown
    onChange(value: string): void; onSubmit(): void
  }) => createElement('div', { 'data-composer-seat': '', 'data-external-composer': '' },
    createElement('textarea', {
      'aria-label': ariaLabel, placeholder, value, disabled,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      onKeyDown: (event: { key: string; preventDefault(): void }) => { if (event.key === 'Enter') { event.preventDefault(); onSubmit() } },
    }),
    modelControl as never,
  ),
}))

const { SessionComposer } = await import('../src/client/session-composer.js')

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('SessionComposer over the native ExternalComposer', () => {
  it('leaves the native composer as the sole seat so the input stays usable', async () => {
    function Harness() {
      const [value, setValue] = useState('')
      return createElement(SessionComposer, {
        value, busy: false, canSend: true, active: false, attachments: [],
        onChange: setValue, onSend() {}, onStop() {},
        onAddImage() {}, onRemoveAttachment() {},
        modelControl: createElement('span', { 'data-testid': 'model' }, 'model'),
      })
    }
    await act(async () => root.render(createElement(Harness)))

    // Regression: exactly one composer seat — the native one. The old wrapper
    // added a second `[data-composer-seat]` that collapsed/overlaid the editor.
    expect(host.querySelectorAll('[data-composer-seat]')).toHaveLength(1)
    expect(host.querySelector('[data-external-composer] [data-composer-seat]')).toBeNull()

    // The native input is still reachable and editable.
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Message to selected session"]')!
    expect(input).not.toBeNull()
    expect(input.disabled).toBe(false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Typed text')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message to selected session"]')!.value).toBe('Typed text')

    // Image upload survives: the attach control is present and enabled, and the
    // model control seat is still injected next to the native composer.
    const attach = host.querySelector<HTMLButtonElement>('[aria-label="Attach image"]')!
    expect(attach).not.toBeNull()
    expect(attach.disabled).toBe(false)
    expect(host.querySelector('[data-testid="model"]')).not.toBeNull()
  })

  it('adds a pasted image without blocking the editor', async () => {
    const added: string[] = []
    await act(async () => root.render(createElement(SessionComposer, {
      value: '', busy: false, canSend: true, active: false, attachments: [],
      onChange() {}, onSend() {}, onStop() {},
      onAddImage(image: { filename: string }) { added.push(image.filename) }, onRemoveAttachment() {},
    })))
    const seat = host.querySelector<HTMLDivElement>('div')!
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => file }] } })
    await act(async () => { seat.dispatchEvent(paste) })
    // FileReader resolves asynchronously; allow the microtask/macrotask to flush.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(added).toEqual(['shot.png'])
    // A plain-text paste must NOT be intercepted (no files → default preserved).
    const textPaste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown }
    Object.defineProperty(textPaste, 'clipboardData', { value: { items: [{ kind: 'string', getAsFile: () => null }] } })
    await act(async () => { seat.dispatchEvent(textPaste) })
    expect(textPaste.defaultPrevented).toBe(false)
  })
})
