import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FooterAction, WorkspaceController, inject, apply, ControlPanelIcon } from '../src/client/index.js'

describe('client components', () => {
  it('registers a native control panel after Automations on the current shell', () => {
    const register = vi.fn((_options: { name: string; inject?: () => unknown }, _component: unknown) => () => {})
    const ctx = {
      connection: {}, remote: { session: {} },
      get: () => undefined,
      effect: () => {},
      inject: () => {},
      slots: { spec: (name: string) => name === 'main' ? { kind: 'keyed' } : undefined,
        inject: (_name: string, callback: () => void) => callback(), register },
    }
    apply(ctx as never)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'sidebar.panellist', id: 'agent-control', order: 20, label: 'Agent 控制台' }), ControlPanelIcon)
    const page = register.mock.calls.find(([options]) => (options as { name?: string }).name === 'main')
    expect(page).toBeDefined()
    expect((page![0] as { inject(): { page: boolean } }).inject().page).toBe(true)
    expect(register.mock.calls.some(([options]) => (options as { name?: string }).name === 'sidebar.footer.action')).toBe(false)
  })
  it('waits for native session services without replacing their UI', () => {
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
    const source = ['index.tsx', 'session-store.ts'].map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')).join('\n')
    expect(source).not.toMatch(/Authorization|Bearer|AGENT_BRIDGE|WORKER_API_TOKEN|127\.0\.0\.1:8787|hermesRoot|hermesHome/)
    expect(source).not.toMatch(/name: 'sidebar.workspaces'|name: 'conversation'|ExternalComposer|ExternalSessionBrowser/)
  })

  it('uses the Agent Bridge sessionId contract for session operations', () => {
    const source = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("session['sessionId']")
    expect(source).not.toContain("session['id']")
    expect(source).not.toContain("selected['id']")
  })
})
