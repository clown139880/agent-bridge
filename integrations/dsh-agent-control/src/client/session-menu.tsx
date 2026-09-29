import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode, type ComponentType } from 'react'
import { DELETE_SESSION_EVENT } from './native-catalog.js'
import type { WorkspaceHook } from './native-catalog.js'

type Props = Record<string, any>
type Entry = { component: unknown }
type ViewState = { orderBy?: string; sessionOrderByAccount?: Record<string, string[]> }
type SessionSummary = { updatedAt?: number; origin?: string; blank?: boolean }
type SessionList = { ids?: readonly string[]; current?: string; byId?: Record<string, SessionSummary | undefined> }
/** DSH 0.1.5's persisted order account of the flat (ungrouped) list. */
const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'
/** Identity decorations: `session` renders before a row's title; `workspace` replaces a
 * workspace row's title, or returns undefined to keep DSH's own label. */
export interface SidebarDecor { session(id: string): ReactNode; workspace(workspaceId: string, label: string): ReactNode | undefined }
export interface MenuSlots { entries(name: string): readonly Entry[]; subscribe(name: string, listener: () => void): () => void }

/** DSH 0.1.3 compatibility seam: retain the original sidebar, locale, store and
 * slot identity. Only extend the three-item session menu and decorate row
 * identity; project menus and all original callbacks remain owned by DSH.
 * No DOM/title-to-id matching: rows are addressed by their own props. */
export function extendSessionMenu(Component: ComponentType<any>, useWorkspaces?: WorkspaceHook, decor?: SidebarDecor, recency?: () => ReadonlyMap<string, number>): ComponentType<any> {
  const wrappers = new WeakMap<object, ComponentType<any>>()
  const visit = (value: ReactNode, session?: { id: string; title: string }, label?: [string, ReactNode]): ReactNode => {
    if (Array.isArray(value)) return Children.map(value, child => visit(child, session, label))
    if (!isValidElement<Props>(value)) return value
    const props = value.props
    if (session && Array.isArray(props['items']) && ['rename', 'fork', 'archive'].every(id => props['items'].some((item: Props) => item['id'] === id))) {
      const onSelect = props['onSelect'] as (id: string) => void
      return cloneElement(value, {
        items: [...props['items'], { id: 'agent-control-delete', label: '删除会话', icon: <IconTrashOutline16 /> }],
        onSelect: (id: string) => {
          if (id !== 'agent-control-delete') return onSelect(id)
          props['onClose']?.()
          window.dispatchEvent(new CustomEvent(DELETE_SESSION_EVENT, { detail: { nativeId: session.id, title: session.title } }))
        },
      })
    }
    // Follow the browser's own function components to the row. Stop at the
    // row boundary: its returned Menu sits in HoverCard.anchor, not children.
    if (!session && !label && typeof value.type === 'function' && !value.type.prototype?.isReactComponent) {
      const original = value.type as ComponentType<any>
      let wrapped = wrappers.get(original)
      if (!wrapped) {
        wrapped = (input: Props) => {
          const row = input['node']
          const owner = row && typeof row.id === 'string' && typeof input['onArchive'] === 'function' ? { id: row.id as string, title: String(row.title ?? '') } : undefined
          const group = input['group']
          const relabel = !owner && decor && group && typeof group.workspaceId === 'string' && typeof group.label === 'string' && typeof input['onToggle'] === 'function'
            ? decor.workspace(group.workspaceId, group.label) : undefined
          return visit((original as (props: Props) => ReactNode)(input), owner, relabel === undefined ? undefined : [group.label as string, relabel])
        }
        wrappers.set(original, wrapped)
      }
      return cloneElement({ ...value, type: wrapped } as ReactElement<Props>)
    }
    if (label && props['children'] === label[0]) return cloneElement(value, { children: label[1] })
    const update: Props = {}
    for (const key of ['children', 'anchor']) if (props[key] !== undefined) update[key] = visit(props[key], session, label)
    const icon = session && decor && props['role'] === 'treeitem' ? decor.session(session.id) : undefined
    if (icon) {
      // The title is the row's first plain-text child; the status slot precedes it.
      const children = Children.toArray(update['children'])
      const title = children.findIndex(child => isValidElement<Props>(child) && typeof child.props['children'] === 'string')
      children.splice(Math.max(title, 0), 0, <Fragment key="agent-control-identity">{icon}</Fragment>)
      update['children'] = children
    }
    return cloneElement(value, update)
  }
  // One projected Session list per (DSH list snapshot, activity map), so hooks
  // that select the whole list keep a stable snapshot identity.
  const projections = new WeakMap<object, { activity: ReadonlyMap<string, number>; value: SessionList }>()
  const projectSessions = (state: SessionList, activity: ReadonlyMap<string, number>): SessionList => {
    if (!state?.byId || !activity.size) return state
    const cached = projections.get(state)
    if (cached?.activity === activity) return cached.value
    let byId: SessionList['byId']
    for (const [id, summary] of Object.entries(state.byId)) {
      const at = activity.get(id)
      if (summary === undefined || at === undefined || summary.updatedAt === at) continue
      byId ??= { ...state.byId }
      byId[id] = { ...summary, updatedAt: at }
    }
    const value = byId ? { ...state, byId } : state
    projections.set(state, { activity, value })
    return value
  }
  return (props: Props) => {
    const workspaces = useWorkspaces?.(snapshot => snapshot.items)
    const archived = useWorkspaces?.(snapshot => snapshot.archivedSessionIds)
    const activity = recency?.()
    const useStore = props['useStore'] as ((selector: (state: ViewState) => unknown) => unknown) | undefined
    const rawUseSessions = props['useSessions'] as ((selector: (state: SessionList) => unknown) => unknown) | undefined
    // Every DSH generation ranks "updated" order by the list's `updatedAt`
    // (0.1.7 sorts by it directly; 0.1.5 promotes by it). DSH stamps imported
    // Bridge prompts with their sync time, so substitute the Bridge activity.
    const useSessions = rawUseSessions && activity
      ? (selector: (state: SessionList) => unknown) => rawUseSessions(state => selector(projectSessions(state, activity)))
      : rawUseSessions
    const list = useSessions?.(state => state) as SessionList | undefined
    const byId = list?.byId
    const projectedUseStore = workspaces && useStore ? (selector: (state: ViewState) => unknown) => useStore(state => {
      if (state.orderBy !== 'updated') return selector(state)
      // DSH 0.1.5 keeps a persisted order per account and only promotes rows,
      // so a stale order never sinks. Project the complete recency order.
      // Its order-sync effect only accounts for ids it has loaded. Projecting any
      // other id (e.g. a just-deleted Bridge session) makes every sync look stale,
      // so it rewrites the store forever: React #185 and a blank sidebar.
      const projected: Record<string, string[]> = Object.fromEntries(workspaces.map(workspace => [workspace.workspaceId,
        byId ? workspace.sessionIds.filter(id => byId[id] !== undefined) : [...workspace.sessionIds]]))
      if (list?.ids && byId) {
        // Exactly DSH's flat membership (visible, non-subagent rows), or the same loop applies.
        const hidden = new Set(archived ?? [])
        projected[FLAT_SESSION_ORDER_KEY] = list.ids.filter(id => {
          const summary = byId[id]
          return summary !== undefined && summary.origin !== 'subagent' && !hidden.has(id) && (!summary.blank || id === list.current)
        }).sort((left, right) => (byId[right]!.updatedAt ?? 0) - (byId[left]!.updatedAt ?? 0) || (left < right ? -1 : 1))
      }
      return selector({ ...state, sessionOrderByAccount: { ...state.sessionOrderByAccount, ...projected } })
    }) : useStore
    const overrides = { ...(useWorkspaces ? { useWorkspaces } : {}), ...(projectedUseStore ? { useStore: projectedUseStore } : {}), ...(useSessions !== rawUseSessions ? { useSessions } : {}) }
    return visit((Component as (props: Props) => ReactNode)({ ...props, ...overrides }))
  }
}

export function installSessionMenu(slots: MenuSlots, useWorkspaces?: WorkspaceHook, decor?: SidebarDecor, recency?: () => ReadonlyMap<string, number>): () => void {
  const originals = new Map<Entry, { original: unknown; patched: unknown }>()
  const patch = () => {
    for (const entry of slots.entries('sidebar.workspaces')) {
      if (originals.has(entry) || typeof entry.component !== 'function') continue
      const original = entry.component
      const patched = extendSessionMenu(original as ComponentType<any>, useWorkspaces, decor, recency)
      originals.set(entry, { original, patched }); entry.component = patched
    }
  }
  patch()
  const unsubscribe = slots.subscribe('sidebar.workspaces', patch)
  return () => { unsubscribe(); for (const [entry, saved] of originals) if (entry.component === saved.patched) entry.component = saved.original }
}
