import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode, type ComponentType } from 'react'
import { DELETE_SESSION_EVENT } from './native-catalog.js'
import type { WorkspaceHook } from './native-catalog.js'

type Props = Record<string, any>
type Entry = { component: unknown }
type ViewState = { orderBy?: string; sessionOrderByAccount?: Record<string, string[]> }
type SessionList = { byId?: Record<string, unknown> }
/** Identity decorations: `session` renders before a row's title; `workspace` replaces a
 * workspace row's title, or returns undefined to keep DSH's own label. */
export interface SidebarDecor { session(id: string): ReactNode; workspace(workspaceId: string, label: string): ReactNode | undefined }
export interface MenuSlots { entries(name: string): readonly Entry[]; subscribe(name: string, listener: () => void): () => void }

/** DSH 0.1.3 compatibility seam: retain the original sidebar, locale, store and
 * slot identity. Only extend the three-item session menu and decorate row
 * identity; project menus and all original callbacks remain owned by DSH.
 * No DOM/title-to-id matching: rows are addressed by their own props. */
export function extendSessionMenu(Component: ComponentType<any>, useWorkspaces?: WorkspaceHook, decor?: SidebarDecor): ComponentType<any> {
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
  return (props: Props) => {
    const workspaces = useWorkspaces?.(snapshot => snapshot.items)
    const useStore = props['useStore'] as ((selector: (state: ViewState) => unknown) => unknown) | undefined
    const useSessions = props['useSessions'] as ((selector: (state: SessionList) => unknown) => unknown) | undefined
    const byId = useSessions?.(state => state.byId) as SessionList['byId'] | undefined
    const projectedUseStore = workspaces && useStore ? (selector: (state: ViewState) => unknown) => useStore(state => {
      if (state.orderBy !== 'updated') return selector(state)
      // DSH's order-sync effect only accounts for ids it has loaded. Projecting any
      // other id (e.g. a just-deleted Bridge session) makes every sync look stale,
      // so it rewrites the store forever: React #185 and a blank sidebar.
      const projected = Object.fromEntries(workspaces.map(workspace => [workspace.workspaceId,
        byId ? workspace.sessionIds.filter(id => byId[id] !== undefined) : [...workspace.sessionIds]]))
      return selector({ ...state, sessionOrderByAccount: { ...state.sessionOrderByAccount, ...projected } })
    }) : useStore
    return visit((Component as (props: Props) => ReactNode)(useWorkspaces ? { ...props, useWorkspaces, ...(projectedUseStore ? { useStore: projectedUseStore } : {}) } : props))
  }
}

export function installSessionMenu(slots: MenuSlots, useWorkspaces?: WorkspaceHook, decor?: SidebarDecor): () => void {
  const originals = new Map<Entry, { original: unknown; patched: unknown }>()
  const patch = () => {
    for (const entry of slots.entries('sidebar.workspaces')) {
      if (originals.has(entry) || typeof entry.component !== 'function') continue
      const original = entry.component
      const patched = extendSessionMenu(original as ComponentType<any>, useWorkspaces, decor)
      originals.set(entry, { original, patched }); entry.component = patched
    }
  }
  patch()
  const unsubscribe = slots.subscribe('sidebar.workspaces', patch)
  return () => { unsubscribe(); for (const [entry, saved] of originals) if (entry.component === saved.patched) entry.component = saved.original }
}
