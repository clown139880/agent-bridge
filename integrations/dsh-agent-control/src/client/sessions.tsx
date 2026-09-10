import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import * as ApprovalUi from '@deepseek-ai/dsh-client-ui-approval/client'
import * as ConversationUi from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as QuestionsUi from '@deepseek-ai/dsh-client-ui-user-questions/client'
import * as WorkspaceUi from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode, RefAttributes, UIEventHandler } from 'react'
import type { JsonObject } from '../types.js'
import { asArray, asRecord, groupSessions, sessionTitle, str } from './session-model.js'
import { SessionStore } from './session-store.js'
import { eventTime, SessionTimeline } from './session-timeline.js'
import { SessionViewStore } from './session-view-state.js'
import { SessionReader } from './session-reader.js'
import { SessionComposer } from './session-composer.js'
import { BridgeModelControl } from './bridge-model-control.js'
import css from './workspace.module.css'

interface ExternalConversationProps {
  title: string; subtitle?: ReactNode; headerActions?: ReactNode; children?: ReactNode; composer?: ReactNode; overlay?: ReactNode
  className?: string | undefined; scrollAriaLabel?: string; onScroll?: UIEventHandler<HTMLDivElement>
}
const ExternalConversationSurface = (ConversationUi as unknown as { ExternalConversationSurface?: ComponentType<ExternalConversationProps & RefAttributes<HTMLDivElement>> }).ExternalConversationSurface
interface ExternalApprovalProps { requestKey: string; summary: string; detail?: ReactNode; choices: readonly string[]; disabled?: boolean; onDecide(choice: string): void | Promise<void> }
const ExternalApprovalPanel = (ApprovalUi as unknown as { ExternalApprovalPanel?: ComponentType<ExternalApprovalProps> }).ExternalApprovalPanel
interface ExternalQuestionItem { id: string; header?: string; question: string; detail?: string; multiSelect?: boolean; externalAllowOther?: boolean; options?: readonly { label: string; description?: string }[] }
interface ExternalQuestionProps { requestKey: string; questions: readonly ExternalQuestionItem[]; disabled?: boolean; onAnswer(answers: Record<string, { answers: string[] }>): void | Promise<void> }
const ExternalQuestionPanel = (QuestionsUi as unknown as { ExternalQuestionPanel?: ComponentType<ExternalQuestionProps> }).ExternalQuestionPanel
type GroupMode = 'expanded' | 'active' | 'collapsed'
type ExternalSessionBrowserGroup = { key: string; label: string; cwd?: string; expanded: boolean; mode?: GroupMode; pinned?: boolean; canCreate?: boolean; totalCount?: number; hiddenCount?: number; showingMore?: boolean; sessions: Array<{ id: string; title: string; status: string; updatedAt: number; source?: string }> }
interface ExternalSessionBrowserProps { groups: ExternalSessionBrowserGroup[]; currentId?: string; locale?: string; query?: string; groupBy?: 'workspace' | 'flat'; orderBy?: 'manual' | 'updated'; onQueryChange?(value: string): void; onGroupByChange?(value: 'workspace' | 'flat'): void; onOrderByChange?(value: 'manual' | 'updated'): void; onToggle(key: string): void; onCreate?(key: string): void; onOpen(id: string): void; onShowMore?(key: string, expanded: boolean): void; onPinGroup?(key: string): void }
const WorkspaceExports = WorkspaceUi as unknown as { ExternalSessionBrowser?: ComponentType<ExternalSessionBrowserProps>; UnifiedSessionBrowser?: ComponentType<ExternalSessionBrowserProps>; SessionBrowser?: ComponentType<ExternalSessionBrowserProps> }
// DSH 0.4.9 renamed this export; keep both names so the plugin works across clients.
const ExternalSessionBrowser = WorkspaceExports.UnifiedSessionBrowser ?? WorkspaceExports.ExternalSessionBrowser ?? WorkspaceExports.SessionBrowser

const CompatibleSessionBrowser: ComponentType<ExternalSessionBrowserProps> = ({ groups, currentId, query = '', onQueryChange, onToggle, onOpen, onCreate }) => <div className={css.sessionBrowserFallback} role="tree" aria-label="Sessions">
  <input aria-label="Search all conversations" placeholder="Search conversations…" value={query} onChange={event => onQueryChange?.(event.target.value)} />
  {groups.map(group => <section key={group.key}><button type="button" onClick={() => onToggle(group.key)}>{group.expanded ? '▾' : '▸'} {group.label} ({group.totalCount ?? group.sessions.length})</button>{group.canCreate && <button type="button" onClick={() => onCreate?.(group.key)} aria-label={`New conversation in ${group.label}`}>＋</button>}{group.expanded && group.sessions.map(session => <button className={currentId === session.id ? css.selected : ''} key={session.id} type="button" onClick={() => onOpen(session.id)}>{session.status === 'active' ? '● ' : ''}{session.title}</button>)}</section>)}
</div>
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
const activeStatus = (status: string): boolean => ['active', 'waiting_for_approval', 'waiting_for_input'].includes(status)

export interface NativeSessionSummary {
  id: string; displayTitle: string; cwd?: string; running: boolean; completed?: boolean; blank: boolean; updatedAt: number
}
export interface NativeSessionSource {
  list: { getSnapshot(): { ids: string[]; byId: Record<string, NativeSessionSummary>; current?: string; phase: string }; subscribe(listener: () => void): () => void }
  open(id: string): void
  create(options?: { workspaceId?: string; cwd?: string }): Promise<string>
}
export interface NativeWorkspaceSource {
  list: { getSnapshot(): { items: Array<{ workspaceId: string; path: string; title: string; sessionIds: readonly string[] }>; archivedSessionIds: readonly string[]; phase: string }; subscribe(listener: () => void): () => void }
}

function useNativeSnapshot<T>(source: { getSnapshot(): T; subscribe(listener: () => void): () => void }): T {
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source])
  const getSnapshot = useCallback(() => source.getSnapshot(), [source])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

type UnifiedRow = ExternalSessionBrowserGroup['sessions'][number] & { source: 'DSH' | 'Bridge'; rawId: string; unread?: boolean }
type UnifiedGroup = Omit<ExternalSessionBrowserGroup, 'sessions'> & { sessions: UnifiedRow[]; baseLabel?: string; environments?: string[]; nativeWorkspaceId?: string; bridgeWorker?: string; latestAt?: number }

/** One native Workspace browser projection containing both DSH and Bridge sessions. */
export function UnifiedSessions({ store, views, nativeSessions, nativeWorkspaces, bridgeSelected, openBridge, openNative }: {
  store: SessionStore; views: SessionViewStore; nativeSessions: NativeSessionSource; nativeWorkspaces: NativeWorkspaceSource
  bridgeSelected: boolean; openBridge(id: string): void; openNative(id: string): void
}) {
  const bridge = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const native = useNativeSnapshot(nativeSessions.list)
  const workspaces = useNativeSnapshot(nativeWorkspaces.list)
  const view = useSyncExternalStore(views.subscribe, views.snapshot, views.snapshot)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  useEffect(() => { store.activate(); void store.loadWorkers(); if (!store.snapshot().loaded) void store.loadSessions() }, [store])
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const archived = new Set(workspaces.archivedSessionIds)
    const result: UnifiedGroup[] = workspaces.items.map(workspace => ({
      key: `workspace:${workspace.workspaceId}`, label: workspace.title, baseLabel: workspace.title, environments: ['local DSH'], cwd: workspace.path,
      expanded: views.groupMode(`workspace:${workspace.workspaceId}`) !== 'collapsed', canCreate: true,
      nativeWorkspaceId: workspace.workspaceId, sessions: workspace.sessionIds.flatMap(id => {
        const session = native.byId[id]
        if (!session || archived.has(id) || (session.blank && native.current !== id)) return []
        return [{ id: `dsh:${id}`, rawId: id, source: 'DSH' as const, title: session.displayTitle, status: session.running ? 'active' : session.completed ? 'completed' : 'idle', unread: session.completed === true, updatedAt: session.updatedAt }]
      }),
    }))
    const accounted = new Set(workspaces.items.flatMap(workspace => [...workspace.sessionIds]))
    const ungrouped = native.ids.flatMap(id => {
      const session = native.byId[id]
      if (accounted.has(id) || !session || archived.has(id) || (session.blank && native.current !== id)) return []
      return [{ id: `dsh:${id}`, rawId: id, source: 'DSH' as const, title: session.displayTitle, status: session.running ? 'active' : session.completed ? 'completed' : 'idle', unread: session.completed === true, updatedAt: session.updatedAt }]
    })
    if (ungrouped.length) result.push({ key: 'native:ungrouped', label: 'Other conversations', baseLabel: 'Other conversations', environments: ['local DSH'], expanded: views.groupMode('native:ungrouped') !== 'collapsed', sessions: ungrouped })
    for (const bridgeGroup of groupSessions(bridge.sessions, query, true, false, view.sort)) {
      // A path can exist on several machines. Keep each Bridge worker in its own
      // group so the heading identifies the environment for every row below it.
      const key = `bridge:${bridgeGroup.key}`
      const baseLabel = bridgeGroup.title.split(/[\\/]/).filter(Boolean).at(-1) || bridgeGroup.title
      const target: UnifiedGroup = { key, label: baseLabel, baseLabel, environments: [`@${bridgeGroup.worker.replace(/^[^@]+@/, '')}`], cwd: bridgeGroup.title, expanded: views.groupMode(key) !== 'collapsed', canCreate: store.canCreate(bridgeGroup.worker), bridgeWorker: bridgeGroup.worker, sessions: [] }
      result.push(target)
      target.sessions.push(...bridgeGroup.sessions.map(session => ({
        id: `bridge:${str(session['sessionId'])}`, rawId: str(session['sessionId']), source: 'Bridge' as const,
        title: sessionTitle(session), status: str(session['status'], 'idle'), updatedAt: typeof session['updatedAt'] === 'number' ? session['updatedAt'] : 0,
      })))
    }
    for (const group of result) {
      group.label = group.environments?.length ? `${group.baseLabel ?? group.label} · ${group.environments.join(' + ')}` : group.label
      group.sessions = group.sessions.filter(row => !needle || [row.title, group.label, group.cwd ?? '', row.source].some(value => value.toLocaleLowerCase().includes(needle)))
      if (view.sort === 'updatedAt') group.sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      group.latestAt = Math.max(0, ...group.sessions.map(row => row.updatedAt))
      const recentSince = Date.now() - RECENT_WINDOW_MS
      const essential = group.sessions.filter(row => row.updatedAt >= recentSince || activeStatus(row.status) || row.unread === true || row.status === 'error' || row.id === `dsh:${native.current ?? ''}` || row.id === `bridge:${bridge.selected ?? ''}`)
      const all = !view.grouped || query.trim() || expanded.includes(group.key)
      group.totalCount = group.sessions.length; group.hiddenCount = all ? 0 : group.sessions.length - essential.length; group.showingMore = expanded.includes(group.key)
      if (!all) group.sessions = essential
      const mode = views.groupMode(group.key)
      group.mode = mode; group.expanded = mode !== 'collapsed'; group.pinned = view.pinnedGroups.includes(group.key)
      if (mode === 'active') { group.sessions = group.sessions.filter(row => activeStatus(row.status) || row.unread === true); group.hiddenCount = 0; group.showingMore = false }
    }
    const visible = result.filter(group => group.totalCount || !needle).sort((a, b) => {
      const active = (group: UnifiedGroup) => group.sessions.some(row => activeStatus(row.status) || row.unread === true) ? 1 : 0
      const aPin = view.pinnedGroups.indexOf(a.key); const bPin = view.pinnedGroups.indexOf(b.key)
      if (aPin >= 0 || bPin >= 0) return aPin < 0 ? 1 : bPin < 0 ? -1 : aPin - bPin
      return active(b) - active(a) || (b.latestAt ?? 0) - (a.latestAt ?? 0)
    })
    if (view.grouped) return visible
    const sessions = visible.flatMap(group => group.sessions)
    if (view.sort === 'updatedAt') sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    return [{ key: 'unified:flat', label: 'Conversations', expanded: true, totalCount: sessions.length, hiddenCount: 0, sessions }]
  }, [bridge.sessions, bridge.selected, expanded, native, query, store, view.activeOnly, view.collapsed, view.grouped, view.pinnedGroups, view.sort, views, workspaces])
  const currentId = bridgeSelected && bridge.selected ? `bridge:${bridge.selected}` : native.current ? `dsh:${native.current}` : undefined
  const open = (id: string) => id.startsWith('bridge:') ? openBridge(id.slice(7)) : openNative(id.slice(4))
  const create = async (key: string) => {
    const group = groups.find(item => item.key === key); if (!group) return
    setNotice('')
    try {
      if (group.nativeWorkspaceId) { const id = await nativeSessions.create({ workspaceId: group.nativeWorkspaceId }); openNative(id) }
      else if (group.bridgeWorker && group.cwd) {
        await store.createSession(group.bridgeWorker, group.cwd)
        const created = store.snapshot().creation?.action
        if (created?.['status'] === 'succeeded' && typeof created['sessionId'] === 'string') openBridge(created['sessionId'])
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create conversation.') }
  }
  const Browser = ExternalSessionBrowser ?? CompatibleSessionBrowser
  return <div className={css.unifiedBrowser}>
    {notice && <div className={css.notice} role="alert">{notice}</div>}
    {bridge.error && <div className={css.notice} role="alert">Bridge · {bridge.error}<Button size="sm" onClick={() => void store.loadSessions()}>Retry</Button></div>}
    {bridge.creation && <div className={css.notice} role="status">{bridge.creation.notice}{bridge.creation.action?.['status'] === 'accepted' && <Button size="sm" onClick={async () => { await store.checkCreation(); const created = store.snapshot().creation?.action; if (created?.['status'] === 'succeeded' && typeof created['sessionId'] === 'string') openBridge(created['sessionId']) }}>Check creation</Button>}</div>}
    <Browser groups={groups} {...(currentId ? { currentId } : {})} locale={typeof navigator === 'undefined' ? 'en' : navigator.language}
      query={query} groupBy={view.grouped ? 'workspace' : 'flat'} orderBy={view.sort === 'updatedAt' ? 'updated' : 'manual'} onQueryChange={setQuery}
      onGroupByChange={value => views.setGrouped(value === 'workspace')} onOrderByChange={value => views.setSort(value === 'updated' ? 'updatedAt' : 'createdAt')}
      onToggle={key => { const group = groups.find(item => item.key === key); views.toggleGroup(key, Boolean(group?.sessions.some(row => activeStatus(row.status)))) }} onOpen={open} onCreate={key => void create(key)}
      onShowMore={(key, value) => setExpanded(keys => value ? [...new Set([...keys, key])] : keys.filter(item => item !== key))}
      onPinGroup={key => views.toggleGroupPin(key)} />
    {bridge.hasMore && <Button size="sm" className={css.loadMore} disabled={bridge.loading} onClick={() => void store.loadSessions(true)}>{bridge.loading ? 'Loading…' : 'Load more Bridge sessions'}</Button>}
  </div>
}

export function Sessions({ store, views: providedViews, refreshToken, initialSessionId, surface = 'both', onRefresh, onBack }: { store: SessionStore; views?: SessionViewStore; refreshToken: unknown; initialSessionId?: string | undefined; surface?: 'both' | 'list' | 'detail'; onRefresh?: () => void; onBack?: () => void }) {
  const [views] = useState(() => providedViews ?? new SessionViewStore())
  const view = useSyncExternalStore(views.subscribe, views.snapshot, views.snapshot)
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const [query, setQuery] = useState('')
  const listPane = useRef<HTMLElement>(null)
  const [locateRequest, setLocateRequest] = useState(0)
  const locatedRequest = useRef(0)
  const { grouped, attention, collapsed, activeOnly, pinnedGroups, sort } = view
  const [raw, setRaw] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  useEffect(() => {
    if (surface === 'list') return
    store.activate()
    void store.loadWorkers()
    void store.checkCreation()
    if (initialSessionId) store.select(initialSessionId)
    if (!store.snapshot().loaded) void store.loadSessions()
  }, [store, initialSessionId, surface])
  useEffect(() => { if (surface !== 'list' && refreshToken) void store.refresh() }, [store, refreshToken, surface])
  useEffect(() => {
    if (!state.selected || surface === 'list') return
    void store.refreshDetail(state.selected)
    if (!store.snapshot().details[state.selected]?.loaded) void store.loadEvents(state.selected)
  }, [store, state.selected, surface])
  // Shared observable state is the only write target. Stop timers while hidden and on unmount.
  useEffect(() => {
    if (surface === 'list') return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (!store.needsPolling()) return
      void store.checkCreation()
      for (const [id, detail] of Object.entries(store.snapshot().details)) if (detail.action?.['status'] === 'accepted') void store.checkAction(id)
      const id = store.snapshot().selected
      if (id) {
        void store.refreshDetail(id)
        void store.refreshLatestEvents(id)
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [store, surface])
  const groups = useMemo(() => groupSessions(state.sessions, query, grouped, attention, sort).sort((a, b) => {
    const aPin = pinnedGroups.indexOf(a.key); const bPin = pinnedGroups.indexOf(b.key)
    return aPin < 0 && bPin < 0 ? 0 : aPin < 0 ? 1 : bPin < 0 ? -1 : aPin - bPin
  }), [state.sessions, query, grouped, attention, pinnedGroups, sort])
  const selectedId = state.selected
  const selectedGroupKey = groups.find(item => item.sessions.some(row => row['sessionId'] === selectedId))?.key
  const detail = selectedId ? state.details[selectedId] : undefined
  const selected = detail?.session
  const busy = detail?.busy || detail?.action?.['status'] === 'accepted'
  const canAct = selected && !detail?.error && selected['status'] !== 'offline' && asArray(selected['capabilities']).includes('session-actions')
  const canDelete = selected && !['creating', 'active', 'waiting_for_approval', 'waiting_for_input'].includes(str(selected['status']))
  const context = useMemo(() => {
    const projected = asRecord(selected?.['context'])
    if (typeof projected['usedTokens'] === 'number' && typeof projected['contextWindow'] === 'number' && projected['contextWindow'] > 0) {
      return { usedTokens: projected['usedTokens'], contextWindow: projected['contextWindow'] }
    }
    for (let index = (detail?.events.length ?? 0) - 1; index >= 0; index--) {
      const event = detail?.events[index]
      if (event?.['type'] !== 'context.updated') continue
      const payload = asRecord(event['payload'])
      const usedTokens = payload['usedTokens']; const contextWindow = payload['contextWindow']
      if (typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0) return { usedTokens, contextWindow }
    }
    return undefined
  }, [detail?.events, selected])
  useEffect(() => {
    if (selectedGroupKey) views.revealGroup(selectedGroupKey)
  }, [selectedId, selectedGroupKey, views, locateRequest])
  useEffect(() => {
    if (locateRequest === locatedRequest.current) return
    const row = listPane.current?.querySelector('[aria-current="true"]')
    if (row) { row.scrollIntoView({ block: 'nearest' }); locatedRequest.current = locateRequest }
  }, [locateRequest, collapsed])
  const detailActions = selectedId && detail ? <><span className={`${css.status} ${css[`status_${str(selected?.['status'])}`] ?? ''}`} aria-hidden="true" /><span className={css.headerStatus}>{str(selected?.['status'], 'Loading')}</span><Button size="sm" className={css.headerIcon} type="button" aria-label="New conversation in this project" title="New conversation in this project" disabled={!selected || !store.canCreate(str(selected['workerId'])) || state.creation?.busy || state.creation?.action?.['status'] === 'accepted'} onClick={() => selected && void store.createSession(str(selected['workerId']), str(selected['workspace'], ''))}>＋</Button>{onRefresh && <Button size="sm" className={css.headerIcon} type="button" aria-label="Refresh Bridge" title="Refresh Bridge" onClick={onRefresh}>↻</Button>}<details className={css.sessionMenu}><summary aria-label="Conversation actions" title="Conversation actions">•••</summary><div><span className={css.sessionMenuMeta}>History · {detail.events.length}{detail.hasMore ? '+' : ''} events · {str(selected?.['historyCompleteness'], 'coverage unknown')}</span><label className={css.sessionMenuToggle}><input type="checkbox" checked={raw} onChange={event => setRaw(event.target.checked)} /> Show raw events</label><Button size="sm" type="button" disabled={busy || !canAct || !selected?.['activeTurnId']} onClick={() => void store.act(selectedId, 'interrupt_turn')}>Interrupt turn</Button><Button size="sm" type="button" className={css.deleteSession} disabled={Boolean(busy || !canDelete)} title={canDelete ? 'Permanently remove this Bridge session and its retained data' : 'Interrupt or resolve the session before deleting it'} onClick={async () => {
    if (!selected || !window.confirm(`Permanently delete “${sessionTitle(selected)}” from Codex?\n\nCodex will also delete conversations spawned from it. This cannot be undone.`)) return
    await store.deleteSession(selectedId)
  }}>Delete conversation</Button>{onBack && <Button size="sm" type="button" onClick={onBack}>Back to DSH sessions</Button>}</div></details></> : null
  const history = selectedId && detail ? <>
    {detail.error && <div className={css.notice} role="alert">{detail.error}<Button size="sm" onClick={() => void store.refreshDetail(selectedId)}>Retry session</Button></div>}
    {selected?.['historyCompleteness'] === 'terminal-only' && <div className={css.coverageNotice}>This source provides turn summaries only. Messages and tool details are not available.</div>}
    {detail.approvals.map(item => <ApprovalCard key={str(item['id'])} item={item} disabled={Boolean(busy || !canAct)} decide={async choice => {
      if (!await store.act(selectedId, 'resolve_approval', { approvalId: str(item['id']), choice })) throw new Error(store.snapshot().details[selectedId]?.notice || 'Approval could not be submitted.')
    }} />)}
    {detail.inputs.map(item => <InputCard key={str(item['id'])} item={item} disabled={Boolean(busy || !canAct)} submit={async answers => {
      if (!await store.act(selectedId, 'respond_user_input', { requestId: str(item['id']), answers })) throw new Error(store.snapshot().details[selectedId]?.notice || 'Answers could not be submitted.')
    }} />)}
    {detail.eventsError && <div className={css.notice} role="alert">{detail.eventsError}<Button size="sm" onClick={() => void store.loadEvents(selectedId, true)}>Reload available history</Button></div>}
    {detail.events.length === 0 && <p className={css.empty}>{detail.eventsLoading ? 'Loading latest history…' : detail.loaded ? 'No retained events.' : 'History has not loaded.'}</p>}
    {detail.hasMore && <Button size="sm" className={css.loadEarlier} disabled={detail.eventsLoading} onClick={() => void store.loadEvents(selectedId)}>{detail.eventsLoading ? 'Loading…' : 'Load earlier messages'}</Button>}
    <SessionTimeline events={detail.events} raw={raw} />
  </> : null
  const composer = selectedId && detail ? <>
    {detail.notice && <div className={css.notice} role="status">{detail.notice}{detail.action?.['status'] === 'accepted' && <Button size="sm" onClick={() => void store.checkAction(selectedId)}>Check outcome</Button>}</div>}
    {selected && !canAct && !detail.loading && !detail.error && <small className={css.readOnly}>This session is read-only: its worker is offline or session actions are unavailable.</small>}
    <SessionComposer value={detail.draft} busy={Boolean(busy)} canSend={Boolean(canAct)} active={selected?.['status'] === 'active'}
      modelControl={selected ? <BridgeModelControl store={store} sessionId={selectedId} workerId={str(selected['workerId'])} selected={detail.model || str(selected['model'])} selectedEffort={detail.reasoningEffort} locked={Boolean(busy || !canAct || selected['activeTurnId'])} /> : undefined}
      {...(context ? { context } : {})}
      onChange={value => store.setDraft(selectedId, value)} onSend={() => void store.act(selectedId, 'submit_turn')} onStop={() => void store.act(selectedId, 'interrupt_turn')} />
  </> : null
  const sharedBrowserGroups: ExternalSessionBrowserGroup[] = groups.map(group => {
    const supportsSummary = grouped && !query.trim() && !attention
    const recentSince = Date.now() - RECENT_WINDOW_MS
    const summaryRows = supportsSummary ? group.sessions.filter(session => (typeof session['updatedAt'] === 'number' && session['updatedAt'] >= recentSince) || activeStatus(str(session['status'])) || session['status'] === 'error' || session['sessionId'] === selectedId) : group.sessions
    const showingMore = expandedGroups.includes(group.key)
    const mode = views.groupMode(group.key)
    const rows = mode === 'active' ? group.sessions.filter(session => activeStatus(str(session['status']))) : showingMore || !supportsSummary ? group.sessions : summaryRows
    return {
      key: group.key,
      label: `${surface === 'list' ? group.title.split(/[\\/]/).filter(Boolean).at(-1) || group.title : group.title}${group.worker ? ` · @${group.worker.replace(/^[^@]+@/, '')}` : ''}`,
      ...(group.title === 'No workspace' ? {} : { cwd: group.title }),
      expanded: mode !== 'collapsed', mode, pinned: pinnedGroups.includes(group.key),
      canCreate: Boolean(group.worker && group.title !== 'No workspace' && store.canCreate(group.worker) && !state.creation?.busy && state.creation?.action?.['status'] !== 'accepted'),
      totalCount: group.sessions.length,
      hiddenCount: mode === 'active' ? 0 : supportsSummary ? group.sessions.length - summaryRows.length : 0,
      showingMore: mode === 'active' ? false : showingMore,
      sessions: rows.map(session => ({
        id: str(session['sessionId']), title: sessionTitle(session), status: str(session['status'], 'idle'),
        updatedAt: typeof session[sort] === 'number' ? session[sort] : 0,
      })),
    }
  })
  return <div className={surface === 'both' ? css.split : css.singleSurface}>
    {surface !== 'detail' && <aside className={css.listPane} ref={listPane}>
      <div className={css.listHeading}>Sessions <span>{state.sessions.length}{state.hasMore ? '+' : ''}</span></div>
      <div className={css.sessionFilters}>
        <input aria-label="Search loaded sessions" placeholder="Search loaded titles or paths…" value={query} onChange={event => setQuery(event.target.value)} />
        <details className={css.viewOptions}><summary>View options · {groups.reduce((count, group) => count + group.sessions.length, 0)} sessions</summary>
        <div><label>Sort loaded sessions <select aria-label="Sort sessions" value={sort} onChange={event => views.setSort(event.target.value as 'createdAt' | 'updatedAt')}><option value="createdAt">Newest created</option><option value="updatedAt">Recently updated</option></select></label></div>
        {sort === 'updatedAt' && <small>Updated means the last real session activity.</small>}
        <div><select aria-label="Group sessions" value={grouped ? 'workspace' : 'flat'} onChange={event => views.setGrouped(event.target.value === 'workspace')}><option value="workspace">Workspace</option><option value="flat">Recent sessions</option></select>
          <label><input type="checkbox" checked={attention} onChange={event => views.setAttention(event.target.checked)} /> Needs attention</label></div>
        <div><Button size="sm" type="button" disabled={!groups.length} onClick={() => views.setGroupsCollapsed(groups.map(group => group.key), true)}>Collapse groups</Button><Button size="sm" type="button" disabled={!groups.length} onClick={() => views.setGroupsCollapsed(groups.map(group => group.key), false)}>Expand groups</Button></div>
        <div><small>{groups.reduce((count, group) => count + group.sessions.length, 0)} matching · {groups.length} groups</small><Button size="sm" type="button" disabled={!selectedId || !state.sessions.some(row => row['sessionId'] === selectedId)} onClick={() => { setQuery(''); views.setAttention(false); setLocateRequest(value => value + 1) }}>Locate current</Button></div>
        </details>
      </div>
      {state.error && <div className={css.notice} role="alert">{state.error}<Button size="sm" onClick={() => void store.loadSessions()}>Retry</Button></div>}
      {state.workersError && <div className={css.notice} role="alert">Cannot check project creation availability.<Button size="sm" onClick={() => void store.loadWorkers()}>Retry workers</Button></div>}
      {state.creation && <div className={css.notice} role="status">{state.creation.notice}{state.creation.action?.['status'] === 'accepted' && <Button size="sm" onClick={() => void store.checkCreation()}>Check creation</Button>}{state.creation.action?.['status'] === 'succeeded' && typeof state.creation.action['sessionId'] === 'string' && <Button size="sm" onClick={() => store.select(str(state.creation?.action?.['sessionId']))}>Open conversation</Button>}</div>}
      {!state.loaded && state.loading && <p className={css.empty}>Loading sessions…</p>}
      {state.loaded && groups.length === 0 && <p className={css.empty}>{query || attention ? 'No matches in loaded sessions.' : 'No sessions.'}</p>}
      {ExternalSessionBrowser ? <ExternalSessionBrowser
        groups={sharedBrowserGroups} {...(selectedId ? { currentId: selectedId } : {})} locale={typeof navigator === 'undefined' ? 'en' : navigator.language}
        onToggle={key => { const group = groups.find(item => item.key === key); views.toggleGroup(key, Boolean(group?.sessions.some(row => activeStatus(str(row['status']))))) }} onOpen={id => store.select(id)} onPinGroup={key => views.toggleGroupPin(key)}
        onShowMore={(key, expanded) => setExpandedGroups(keys => expanded ? [...new Set([...keys, key])] : keys.filter(item => item !== key))}
        onCreate={key => { const group = groups.find(item => item.key === key); if (group?.worker && group.title !== 'No workspace') void store.createSession(group.worker, group.title) }}
      /> : groups.map(group => {
        const mode = views.groupMode(group.key)
        const compact = grouped && !query.trim() && !attention && !expandedGroups.includes(group.key)
        const recentSince = Date.now() - RECENT_WINDOW_MS
        const visible = mode === 'active' ? group.sessions.filter(session => activeStatus(str(session['status']))) : compact ? group.sessions.filter(session => (typeof session['updatedAt'] === 'number' && session['updatedAt'] >= recentSince) || activeStatus(str(session['status'])) || session['status'] === 'error' || session['sessionId'] === selectedId) : group.sessions
        const hiddenCount = group.sessions.length - visible.length
        return <section key={group.key}>
        <div className={css.projectHeading}>
        <Button size="sm" className={css.groupHeading} type="button" aria-expanded={mode !== 'collapsed'} onClick={() => views.toggleGroup(group.key, group.sessions.some(session => activeStatus(str(session['status']))))} title={group.title}>
          <span>{mode === 'collapsed' ? '▸' : mode === 'active' ? '●' : '▾'} {surface === 'list' ? group.title.split(/[\\/]/).filter(Boolean).at(-1) || group.title : group.title}</span><small>{mode === 'active' ? 'Active only · ' : ''}{group.worker} · {group.sessions.length}</small>
        </Button>
        <Button size="sm" type="button" className={css.pinButton} aria-label={`${pinnedGroups.includes(group.key) ? 'Unpin' : 'Pin'} project ${group.title}`} aria-pressed={pinnedGroups.includes(group.key)} onClick={() => views.toggleGroupPin(group.key)}>{pinnedGroups.includes(group.key) ? '★' : '☆'}</Button>
        {group.worker && group.title !== 'No workspace' && <Button size="sm" className={css.newProjectSession} type="button" aria-label={`New conversation in ${group.title}`} title={store.canCreate(group.worker) ? `New conversation · ${group.worker} · ${group.title}` : 'Worker offline or session creation unavailable'} disabled={!store.canCreate(group.worker) || state.creation?.busy || state.creation?.action?.['status'] === 'accepted'} onClick={() => void store.createSession(group.worker, group.title)}>＋</Button>}
        </div>
        {mode !== 'collapsed' && visible.map(session => <div className={css.sessionRow} key={str(session['sessionId'])}><Button size="sm" className={`${css.sessionItem} ${selectedId === session['sessionId'] ? css.selected : ''}`} onClick={() => store.select(str(session['sessionId']))} type="button" aria-current={selectedId === session['sessionId'] ? 'true' : undefined}>
          <span className={`${css.status} ${css[`status_${str(session['status'])}`] ?? ''}`} /><span><strong>{sessionTitle(session)}</strong><small>{str(session['status'])} · {str(session['source'], 'Bridge')}</small><small title={sort === 'createdAt' ? 'Created' : 'Updated'}>{eventTime(session[sort]) || 'Time unavailable'}</small></span>
        </Button></div>)}
        {mode === 'expanded' && hiddenCount > 0 && <Button size="sm" type="button" className={css.showOlder} onClick={() => setExpandedGroups(keys => [...keys, group.key])}>Show {hiddenCount} older conversation{hiddenCount === 1 ? '' : 's'}</Button>}
        {mode === 'expanded' && expandedGroups.includes(group.key) && group.sessions.length > 0 && <Button size="sm" type="button" className={css.showOlder} onClick={() => setExpandedGroups(keys => keys.filter(key => key !== group.key))}>Hide older conversations</Button>}
      </section>})}
      {state.hasMore && <Button size="sm" className={css.loadMore} disabled={state.loading} onClick={() => void store.loadSessions(true)}>{state.loading ? 'Loading…' : 'Load more sessions'}</Button>}
    </aside>}
    {surface !== 'list' && <main className={css.detailPane}>
      {!selectedId || !detail ? <p className={css.empty}>Select a session.</p> : <>
        {ExternalConversationSurface ? <SessionReader key={selectedId} sessionId={selectedId} views={views} eventCount={detail.events.length} {...(typeof detail.events[0]?.['eventId'] === 'string' ? { oldestEventId: detail.events[0]['eventId'] } : {})} loaded={detail.loaded} raw={raw} hasEarlier={detail.hasMore} loadingEarlier={detail.eventsLoading} onLoadEarlier={() => void store.loadEvents(selectedId)}
          renderSurface={({ scrollRef, onScroll, overlay, children }) => <ExternalConversationSurface ref={scrollRef} className={css.externalConversationSurface} title={selected ? sessionTitle(selected) : selectedId} subtitle={selected ? <span className={css.externalHeaderMeta} title={`${str(selected['workspace'])} · ${str(selected['workerId'])}`}>{str(selected['workspace'])}</span> : 'Loading session…'} headerActions={detailActions} composer={composer} overlay={overlay} scrollAriaLabel="Session history" onScroll={onScroll}><div className={css.externalTimeline}>{children}</div></ExternalConversationSurface>}>
          {history}
        </SessionReader> : <>
          <header className={css.detailHeader}><div className={css.sessionIdentity}><h2>{selected ? sessionTitle(selected) : selectedId}</h2><p>{selected ? `${str(selected['workspace'])} · ${str(selected['workerId'])}` : 'Loading session…'}</p></div><div className={css.headerActions}>{detailActions}</div></header>
          <SessionReader key={selectedId} sessionId={selectedId} views={views} eventCount={detail.events.length} {...(typeof detail.events[0]?.['eventId'] === 'string' ? { oldestEventId: detail.events[0]['eventId'] } : {})} loaded={detail.loaded} raw={raw} hasEarlier={detail.hasMore} loadingEarlier={detail.eventsLoading} onLoadEarlier={() => void store.loadEvents(selectedId)}>{history}</SessionReader>
          {composer}
        </>}
      </>}
    </main>}
  </div>
}

function ApprovalCard({ item, disabled, decide }: { item: JsonObject; disabled: boolean; decide(choice: string): void | Promise<void> }) {
  const choices = asArray(item['choices']).filter((choice): choice is string => typeof choice === 'string')
  const summary = str(item['summary'], str(item['kind']))
  return ExternalApprovalPanel
    ? <ExternalApprovalPanel requestKey={str(item['id'])} summary={summary.split('\n')[0] ?? summary} detail={summary.includes('\n') ? summary.split('\n').slice(1).join('\n') : undefined} choices={choices} disabled={disabled} onDecide={decide} />
    : <div className={css.pending}><div><strong>Action required</strong><span>{summary}</span></div>{choices.map(choice => <Button size="sm" disabled={disabled} key={choice} type="button" onClick={() => void decide(choice)}>{choice}</Button>)}</div>
}
function InputCard({ item, disabled, submit }: { item: JsonObject; disabled: boolean; submit(answers: JsonObject): void | Promise<void> }) {
  const questions = asArray(item['questions']).map(asRecord)
  const nativeQuestions: ExternalQuestionItem[] = questions.map(question => ({
    id: str(question['id']),
    ...(typeof question['header'] === 'string' && question['header'] ? { header: question['header'] } : {}),
    question: str(question['question'], 'Input required'),
    externalAllowOther: question['isOther'] === true,
    ...(Array.isArray(question['options']) && question['options'].length > 0 ? { options: question['options'].map(asRecord).map(option => ({ label: str(option['label']), ...(typeof option['description'] === 'string' && option['description'] ? { description: option['description'] } : {}) })) } : {}),
  }))
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const hasSecret = questions.some(question => question['isSecret'] === true)
  if (ExternalQuestionPanel && !hasSecret && nativeQuestions.length > 0) return <ExternalQuestionPanel requestKey={str(item['id'])} questions={nativeQuestions} disabled={disabled} onAnswer={submit} />
  return <form className={css.inputCard} onSubmit={event => {
    event.preventDefault(); if (hasSecret || disabled) return
    void submit(Object.fromEntries(questions.map(question => [str(question['id']), { answers: [answers[str(question['id'])] ?? ''] }])))
  }}><strong>Agent needs input</strong>
    {questions.map(question => { const key = str(question['id']); const options = asArray(question['options']).map(asRecord); return <label key={key}><span>{str(question['header'])}: {str(question['question'])}</span>{question['isSecret'] === true ? <em>Secret input must be answered in the trusted local agent UI.</em> : <><input disabled={disabled} list={options.length ? `answers-${str(item['id'])}-${key}` : undefined} value={answers[key] ?? ''} onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))} />{options.length > 0 && <datalist id={`answers-${str(item['id'])}-${key}`}>{options.map(option => <option key={str(option['label'])} value={str(option['label'])}>{str(option['description'], '')}</option>)}</datalist>}</>}</label> })}
    <Button size="sm" type="submit" disabled={disabled || hasSecret || questions.some(question => !(answers[str(question['id'])] ?? '').trim())}>{hasSecret ? 'Local handling required' : 'Submit answers'}</Button>
  </form>
}
