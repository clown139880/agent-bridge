import { useState, useSyncExternalStore } from 'react'
import type { SessionStore } from './session-store.js'
import type { SessionViewStore } from './session-view-state.js'
import { sessionTitle, str } from './session-model.js'
import css from './workspace.module.css'

/** Additive sidebar entry: external references never enter the native Session controller. */
export function SessionShortcuts({ store, views, openSession, wide }: { store: SessionStore; views: SessionViewStore; openSession(id: string): void; wide: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const data = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  void views
  const recent = [...data.sessions].sort((a, b) => Number(b['updatedAt'] ?? 0) - Number(a['updatedAt'] ?? 0)).slice(0, 5)
  return <div className={css.shortcutRoot}>
    <button type="button" className={css.footerButton} aria-label="Recent Bridge sessions" aria-expanded={expanded && wide} onClick={() => {
      if (!wide) { openSession(''); return }
      setExpanded(value => !value)
      if (!expanded) { store.activate(); void store.loadSessions() }
    }}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{wide && <span>Bridge sessions</span>}</button>
    {expanded && wide && <div className={css.shortcutList}>
      {data.error && <small role="alert">{data.error}</small>}
      {data.loading && <small>Loading…</small>}
      {!data.loading && !data.error && recent.length === 0 && <small>No sessions.</small>}
      {recent.map(row => <button key={str(row['sessionId'])} type="button" title={`${str(row['workerId'])} · ${str(row['workspace'])}`} onClick={() => openSession(str(row['sessionId']))}>
        <strong>{sessionTitle(row)}</strong><small>{str(row['status'])} · {str(row['workerId'])}</small>
      </button>)}
      <small>Recent · {data.sessions.length}{data.hasMore ? '+' : ''} loaded</small>
    </div>}
  </div>
}
