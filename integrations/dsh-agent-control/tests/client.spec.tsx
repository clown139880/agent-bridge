import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FooterAction, WorkspaceController, inject } from '../src/client/index.js'

describe('client components', () => {
  it('waits for the native session services before registering the unified sidebar', () => {
    expect(inject).toEqual(expect.arrayContaining(['sessions', 'workspaces']))
  })

  it('renders an accessible sidebar entry in wide and rail modes', () => {
    const controller = new WorkspaceController()
    const Component = FooterAction as unknown as (props: { wide: boolean; controller: WorkspaceController }) => JSX.Element
    const wide = renderToStaticMarkup(createElement(Component, { wide: true, controller }))
    const rail = renderToStaticMarkup(createElement(Component, { wide: false, controller }))
    expect(wide).toContain('Agent Control')
    expect(rail).toContain('aria-label="Open Agent Control"')
  })

  it('notifies subscribers for open/close view-state changes', () => {
    const controller = new WorkspaceController(); let calls = 0
    const dispose = controller.subscribe(() => { calls += 1 })
    controller.open(); expect(controller.snapshot()).toBe(true)
    controller.close(); expect(controller.snapshot()).toBe(false)
    dispose(); controller.open(); expect(calls).toBe(2)
  })

  it('contains no Host token, Bridge origin, or Hermes path in the browser source', () => {
    const source = ['index.tsx', 'sessions.tsx', 'session-store.ts', 'bridge-model-control.tsx'].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n')
    expect(source).not.toMatch(/Authorization|Bearer|AGENT_BRIDGE|WORKER_API_TOKEN|127\.0\.0\.1:8787|hermesRoot|hermesHome/)
    expect(source).toContain('Model for next turn')
  })

  it('uses the Agent Bridge sessionId contract for session operations', () => {
    const source = ['index.tsx', 'sessions.tsx'].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n')
    expect(source).toContain("session['sessionId']")
    expect(source).not.toContain("session['id']")
    expect(source).not.toContain("selected['id']")
  })
})
