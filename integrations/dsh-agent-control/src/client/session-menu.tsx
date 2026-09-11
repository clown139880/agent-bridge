import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, type ComponentType } from 'react'
import { DELETE_SESSION_EVENT } from './native-catalog.js'

type Props = Record<string, any>
type Entry = { component: unknown }
export interface MenuSlots { entries(name: string): readonly Entry[]; subscribe(name: string, listener: () => void): () => void }

/** DSH 0.1.3 compatibility seam: retain the original sidebar, locale, store and
 * slot identity. Only extend the three-item session menu; project menus and
 * all original callbacks remain owned by DSH. No DOM/title-to-id matching. */
export function extendSessionMenu(Component: ComponentType<any>): ComponentType<any> {
  const wrappers = new WeakMap<object, ComponentType<any>>()
  const visit = (value: ReactNode, session?: { id: string; title: string }): ReactNode => {
    if (Array.isArray(value)) return Children.map(value, child => visit(child, session))
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
    if (!session && typeof value.type === 'function' && !value.type.prototype?.isReactComponent) {
      const original = value.type as ComponentType<any>
      let wrapped = wrappers.get(original)
      if (!wrapped) {
        wrapped = (input: Props) => {
          const row = input['node']
          const owner = row && typeof row.id === 'string' && typeof input['onArchive'] === 'function' ? { id: row.id as string, title: String(row.title ?? '') } : undefined
          return visit((original as (props: Props) => ReactNode)(input), owner)
        }
        wrappers.set(original, wrapped)
      }
      return cloneElement({ ...value, type: wrapped } as ReactElement<Props>)
    }
    const update: Props = {}
    for (const key of ['children', 'anchor']) if (props[key] !== undefined) update[key] = visit(props[key], session)
    return cloneElement(value, update)
  }
  return (props: Props) => visit((Component as (props: Props) => ReactNode)(props))
}

export function installSessionMenu(slots: MenuSlots): () => void {
  const originals = new Map<Entry, { original: unknown; patched: unknown }>()
  const patch = () => {
    for (const entry of slots.entries('sidebar.workspaces')) {
      if (originals.has(entry) || typeof entry.component !== 'function') continue
      const original = entry.component
      const patched = extendSessionMenu(original as ComponentType<any>)
      originals.set(entry, { original, patched }); entry.component = patched
    }
  }
  patch()
  const unsubscribe = slots.subscribe('sidebar.workspaces', patch)
  return () => { unsubscribe(); for (const [entry, saved] of originals) if (entry.component === saved.patched) entry.component = saved.original }
}
