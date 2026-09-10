/**
 * Native DSH session-tree derivation, kept dependency-free so it stays testable
 * without the DSH client bundles and can track DSH's own rules directly.
 *
 * The plugin projects DSH's native sessions into the unified browser. To match
 * the client's own tree exactly, these helpers mirror DSH's `sessionVisible`,
 * `indexSubagentDescendants`, and `sessionNode`: subagent conversations render
 * under their parent (never as their own row), and a parent counts as active
 * while a subagent it spawned is still running.
 */

/** One raw native session summary as published by DSH's session list service. */
export interface NativeSessionSummary {
  id: string
  displayTitle: string
  cwd?: string
  running: boolean
  completed?: boolean
  blank: boolean
  updatedAt: number
  /** DSH marks spawned conversations with `origin: 'subagent'` + a `parentId`. */
  origin?: string
  parentId?: string
}

/** A native session projected into a unified browser row. */
export interface NativeRow {
  id: string
  rawId: string
  source: 'DSH'
  title: string
  status: string
  unread?: boolean
  updatedAt: number
}

/**
 * Count uninterrupted running subagent descendants per ancestor, mirroring DSH's
 * `indexSubagentDescendants`. A running subagent contributes to every ancestor
 * reachable through an unbroken subagent lineage.
 */
export function subagentRunningCounts(byId: Record<string, NativeSessionSummary>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const node of Object.values(byId)) {
    if (node.origin !== 'subagent' || !node.running) continue
    const seen = new Set<string>()
    let current: NativeSessionSummary | undefined = node
    while (current?.origin === 'subagent' && current.parentId && !seen.has(current.id)) {
      seen.add(current.id)
      counts.set(current.parentId, (counts.get(current.parentId) ?? 0) + 1)
      current = byId[current.parentId]
    }
  }
  return counts
}

/**
 * Native session visibility, mirroring DSH's `sessionVisible`: subagent rows
 * live under their parent, archived rows are hidden everywhere, and a blank
 * (provisional "New Session") row shows only while it is the selected session.
 */
export function nativeVisible(session: NativeSessionSummary | undefined, current: string | undefined, archived: ReadonlySet<string>): session is NativeSessionSummary {
  return !!session && session.origin !== 'subagent' && !archived.has(session.id) && (!session.blank || session.id === current)
}

/** Project a visible native summary into a unified row using DSH's active rules. */
export function nativeRow(session: NativeSessionSummary, runningSubagents: number): NativeRow {
  const status = session.running || runningSubagents > 0 ? 'active' : session.completed ? 'completed' : 'idle'
  return { id: `dsh:${session.id}`, rawId: session.id, source: 'DSH', title: session.displayTitle, status, unread: session.completed === true, updatedAt: session.updatedAt }
}
