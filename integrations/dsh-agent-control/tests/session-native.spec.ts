import { describe, expect, it } from 'vitest'
import { nativeRow, nativeVisible, subagentRunningCounts, type NativeSessionSummary } from '../src/client/session-native.js'

const summary = (over: Partial<NativeSessionSummary> & { id: string }): NativeSessionSummary =>
  ({ displayTitle: over.id, running: false, blank: false, updatedAt: 0, ...over })

describe('native session-tree projection alignment', () => {
  it('hides subagent-origin conversations so they never appear as their own row', () => {
    const archived = new Set<string>()
    const parent = summary({ id: 'p', running: false })
    const child = summary({ id: 'c', origin: 'subagent', parentId: 'p', running: true })
    expect(nativeVisible(parent, undefined, archived)).toBe(true)
    // The subagent row is not visible on its own — DSH renders it under its parent.
    expect(nativeVisible(child, undefined, archived)).toBe(false)
    // Even selecting it does not surface a subagent as a top-level row.
    expect(nativeVisible(child, 'c', archived)).toBe(false)
  })

  it('excludes archived rows and blank rows unless the blank is selected', () => {
    const archived = new Set<string>(['old'])
    expect(nativeVisible(summary({ id: 'old' }), 'old', archived)).toBe(false)
    const blank = summary({ id: 'draft', blank: true })
    expect(nativeVisible(blank, undefined, archived)).toBe(false)
    expect(nativeVisible(blank, 'draft', archived)).toBe(true)
    expect(nativeVisible(undefined, undefined, archived)).toBe(false)
  })

  it('counts running subagents toward every ancestor in the lineage', () => {
    const byId: Record<string, NativeSessionSummary> = {
      root: summary({ id: 'root', running: false }),
      mid: summary({ id: 'mid', origin: 'subagent', parentId: 'root', running: false }),
      leaf: summary({ id: 'leaf', origin: 'subagent', parentId: 'mid', running: true }),
      idle: summary({ id: 'idle', origin: 'subagent', parentId: 'root', running: false }),
    }
    const counts = subagentRunningCounts(byId)
    expect(counts.get('mid')).toBe(1)
    expect(counts.get('root')).toBe(1)
    expect(counts.get('idle')).toBeUndefined()
  })

  it('marks a parent active while a subagent it spawned is still running', () => {
    const parent = summary({ id: 'p', running: false, completed: true })
    // No running subagents → reflects the parent's own state (completed).
    expect(nativeRow(parent, 0).status).toBe('completed')
    // A running subagent lifts the parent to active, matching the native tree.
    expect(nativeRow(parent, 1).status).toBe('active')
    expect(nativeRow(summary({ id: 'r', running: true }), 0).status).toBe('active')
    expect(nativeRow(summary({ id: 'i' }), 0).status).toBe('idle')
    expect(nativeRow(parent, 0)).toMatchObject({ id: 'dsh:p', rawId: 'p', source: 'DSH', unread: true })
  })
})
