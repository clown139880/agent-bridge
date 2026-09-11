import { useEffect, useRef } from 'react'

const dialogs: HTMLElement[] = []
/** Keep keyboard navigation and Escape within the topmost plugin dialog. */
export function useDialog(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const onClose = useRef(close)
  onClose.current = close
  useEffect(() => {
    const root = ref.current
    if (!open || !root) return
    const previous = document.activeElement as HTMLElement | null
    dialogs.push(root)
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length > 0)
    ;(focusable()[0] ?? root).focus()
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== root) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); root.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      const index = dialogs.indexOf(root)
      if (index >= 0) dialogs.splice(index, 1)
      document.removeEventListener('keydown', keydown, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
