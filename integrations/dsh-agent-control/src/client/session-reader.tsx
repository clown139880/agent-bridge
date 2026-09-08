import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject, UIEventHandler } from 'react'
import type { SessionViewStore } from './session-view-state.js'
import css from './workspace.module.css'

/** Reader shell shared by all Bridge content types. Positions anchor to event identity, not array index. */
interface ReaderSurface {
  scrollRef: RefObject<HTMLDivElement>
  onScroll: UIEventHandler<HTMLDivElement>
  overlay: ReactNode
  children: ReactNode
}

export function SessionReader({ sessionId, views, eventCount, oldestEventId, loaded, raw, hasEarlier = false, loadingEarlier = false, onLoadEarlier, children, renderSurface }: { sessionId: string; views: SessionViewStore; eventCount: number; oldestEventId?: string; loaded: boolean; raw: boolean; hasEarlier?: boolean; loadingEarlier?: boolean; onLoadEarlier?: () => void; children: ReactNode; renderSurface?: (surface: ReaderSurface) => ReactNode }) {
  const pane = useRef<HTMLDivElement>(null)
  const restored = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const layout = useRef<{ height: number; oldest?: string }>({ height: 0 })
  const [awayFromEnd, setAwayFromEnd] = useState(false)
  const requestedAtCount = useRef(-1)
  const save = () => {
    const element = pane.current
    if (!element || !restored.current) return
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>('[data-event-id]')].find(item => item.getBoundingClientRect().bottom > top)
    if (row?.dataset['eventId']) views.savePosition(sessionId, { eventId: row.dataset['eventId'], offset: row.getBoundingClientRect().top - top })
  }
  useLayoutEffect(() => {
    const element = pane.current
    if (!element || !loaded || restored.current) return
    element.scrollTop = element.scrollHeight
    layout.current = { height: element.scrollHeight, ...(oldestEventId ? { oldest: oldestEventId } : {}) }
    restored.current = true
  }, [sessionId, loaded, eventCount, raw, oldestEventId])
  useLayoutEffect(() => {
    const element = pane.current
    if (!element || !restored.current) return
    const previous = layout.current
    const nearEnd = previous.height - element.clientHeight - element.scrollTop < 80
    if (previous.oldest && oldestEventId && previous.oldest !== oldestEventId) element.scrollTop += element.scrollHeight - previous.height
    else if (nearEnd) element.scrollTop = element.scrollHeight
    layout.current = { height: element.scrollHeight, ...(oldestEventId ? { oldest: oldestEventId } : {}) }
    setAwayFromEnd(element.scrollHeight - element.clientHeight - element.scrollTop > 80)
  }, [eventCount, oldestEventId, raw])
  useLayoutEffect(() => () => { if (timer.current) clearTimeout(timer.current); save() }, [sessionId, views])
  const onScroll: UIEventHandler<HTMLDivElement> = () => {
      const element = pane.current
      if (!element) return
      restored.current = true
      setAwayFromEnd(element.scrollHeight - element.clientHeight - element.scrollTop > 80)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, 200)
      if (element.scrollTop < 72 && hasEarlier && !loadingEarlier && requestedAtCount.current !== eventCount) {
        requestedAtCount.current = eventCount
        onLoadEarlier?.()
      }
  }
  const overlay = awayFromEnd && <Button size="sm" type="button" className={css.jumpLatest} aria-label="Jump to latest loaded event" onClick={() => {
      if (!pane.current) return
      restored.current = true
      pane.current.scrollTop = pane.current.scrollHeight
      setAwayFromEnd(false)
      save()
    }}>↓ Latest</Button>
  if (renderSurface) return renderSurface({ scrollRef: pane, onScroll, overlay, children })
  return <div className={css.readerShell}>
    <div ref={pane} className={css.timeline} aria-label="Session history" onScroll={onScroll}>{children}</div>
    {overlay}
  </div>
}
