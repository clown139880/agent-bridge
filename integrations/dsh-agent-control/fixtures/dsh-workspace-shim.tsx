import type { ReactNode } from 'react'

export interface ExternalSessionBrowserRow { id: string; title: string; status: string; updatedAt: number; pinned?: boolean; pinnable?: boolean; source?: string }
export interface ExternalSessionBrowserGroup { key: string; label: string; cwd?: string; expanded: boolean; canCreate?: boolean; totalCount?: number; hiddenCount?: number; showingMore?: boolean; sessions: readonly ExternalSessionBrowserRow[] }

/** Preview stand-in. Installed TokensCowork uses DSH Workspace's exact rows and group headers. */
export function ExternalSessionBrowser({ groups, currentId, query = '', groupBy = 'workspace', orderBy = 'updated', onQueryChange, onGroupByChange, onOrderByChange, onToggle, onCreate, onOpen, onShowMore, onPin }: {
  groups: readonly ExternalSessionBrowserGroup[]; currentId?: string
  query?: string; groupBy?: 'workspace' | 'flat'; orderBy?: 'manual' | 'updated'; onQueryChange?(value: string): void; onGroupByChange?(value: 'workspace' | 'flat'): void; onOrderByChange?(value: 'manual' | 'updated'): void
  onToggle(key: string): void; onCreate?(key: string): void; onOpen(id: string): void
  onShowMore?(key: string, expanded: boolean): void; onPin?(id: string): void
}): ReactNode {
  return <div data-external-session-browser role="tree" aria-label="Sessions"><style>{`[data-external-session-browser]{display:flex;flex-direction:column;gap:8px;padding:8px 0;color:#e8edf5}[data-external-session-browser] section>div:first-child{display:flex;align-items:center;padding:0 8px}[data-external-session-browser] button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}[data-external-session-browser] section>div:first-child>button:first-child{flex:1;text-align:left;height:32px;font-weight:600}[data-native-session-row]{display:flex;align-items:center;margin:1px 8px;border-radius:6px}[data-native-session-row][aria-selected=true]{background:#27302c}[data-native-session-row]>button:first-child{flex:1;min-width:0;padding:8px 12px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}[data-native-session-row]>button:last-child{padding:8px}[data-external-session-browser] section>button{margin-left:20px;padding:6px 8px;color:#9ca9a2}`}</style>{onQueryChange && <div><input aria-label="Search all conversations" value={query} onChange={event => onQueryChange(event.target.value)} /><button type="button" onClick={() => onGroupByChange?.(groupBy === 'workspace' ? 'flat' : 'workspace')}>{groupBy}</button><button type="button" onClick={() => onOrderByChange?.(orderBy === 'updated' ? 'manual' : 'updated')}>{orderBy}</button></div>}{groups.map(group => <section key={group.key}>
    <div role="treeitem" aria-expanded={group.expanded}><button type="button" onClick={() => onToggle(group.key)}>{group.expanded ? '▾' : '▸'} {group.label}</button>{group.canCreate && <button type="button" aria-label={`New session in ${group.label}`} onClick={() => onCreate?.(group.key)}>＋</button>}</div>
    {group.expanded && group.sessions.map(session => <div key={session.id} data-native-session-row role="treeitem" aria-selected={session.id === currentId}>
      <button type="button" onClick={() => onOpen(session.id)}>{session.status === 'active' ? '● ' : ''}{session.title}{session.source ? ` · ${session.source}` : ''}</button>
      {onPin && session.pinnable !== false && <button type="button" aria-label={`${session.pinned ? 'Unpin' : 'Pin'} ${session.title}`} onClick={() => onPin(session.id)}>{session.pinned ? '★' : '☆'}</button>}
    </div>)}
    {group.expanded && Boolean(group.hiddenCount) && <button type="button" onClick={() => onShowMore?.(group.key, !group.showingMore)}>{group.showingMore ? 'Show less' : `Show ${group.hiddenCount} more sessions`}</button>}
  </section>)}</div>
}
