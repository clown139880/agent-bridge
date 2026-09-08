import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installBridgeSurfaces, WorkspaceController } from '../src/client/index.js'

describe('Bridge main surface navigation', () => {
  it('keeps one unified sidebar mounted, shadows only conversation, and follows native navigation', () => {
    const active = new Set<string>()
    const cleanup: Array<() => void> = []
    let nativeChanged = () => {}
    let current = 'native-a'
    let detailsClosed = 0
    const ctx = {
      layout: { closeDetails() { detailsClosed++ } },
      get: () => ({ list: { getSnapshot: () => ({ current }), subscribe(fn: () => void) { nativeChanged = fn; return () => { nativeChanged = () => {} } } } }),
      effect(fn: () => () => void) { cleanup.push(fn()) },
      slots: {
        inject(_name: string, fn: () => () => void) { cleanup.push(fn()) },
        register(options: { name: string; priority: number }) {
          expect(options.priority).toBeLessThan(0)
          expect(active.has(options.name)).toBe(false)
          active.add(options.name)
          return () => { active.delete(options.name) }
        },
      },
    }
    const controller = new WorkspaceController(async () => null)
    installBridgeSurfaces(ctx as unknown as Context, controller)
    expect([...active]).toEqual(['sidebar.workspaces'])
    controller.openSession('')
    expect(controller.snapshot()).toBe(false)
    expect([...active]).toEqual(['sidebar.workspaces', 'conversation'])
    controller.openSession('')
    expect(detailsClosed).toBe(1)
    controller.showNative()
    expect([...active]).toEqual(['sidebar.workspaces'])
    controller.openSession('')
    current = 'native-b'; nativeChanged()
    expect(controller.bridgeSnapshot()).toBe(false)
    expect([...active]).toEqual(['sidebar.workspaces'])
    controller.openSession('')
    cleanup.reverse().forEach(dispose => dispose())
    expect(active.size).toBe(0)
    controller.showNative(); controller.openSession('')
    expect(active.size).toBe(0)
  })
})
