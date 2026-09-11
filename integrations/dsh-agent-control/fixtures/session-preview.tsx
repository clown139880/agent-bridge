/** Development-only bundle harness. Uses real React/primitives and mock Host RPC; no live connection. */
import * as React from 'react'
import { createRoot } from 'react-dom/client'

const root = createRoot(document.getElementById('root')!)
const showError = (label: string, error: unknown) => root.render(<pre style={{ padding: 16, whiteSpace: 'pre-wrap', color: '#ff9b9b' }}>{label}: {error instanceof Error ? error.stack ?? error.message : String(error)}</pre>)
window.addEventListener('error', event => showError('Preview runtime error', event.error ?? event.message))
window.addEventListener('unhandledrejection', event => showError('Preview rejection', event.reason))
const rows: Array<{ name: string; inject(): Record<string, unknown>; component: React.ComponentType<any> }> = []
const nativeSnapshot = { ids: ['native-1', 'shared-id'], byId: {
    'native-1': { id: 'native-1', displayTitle: 'Native DSH conversation', cwd: '/work/dsh-plugin', running: true, blank: false, updatedAt: Date.now() },
    'shared-id': { id: 'shared-id', displayTitle: 'Same id, native source', cwd: '/work/agent-bridge', running: false, blank: false, updatedAt: Date.now() - 3000 },
  }, current: 'native-1', phase: 'ready' }
const workspaceSnapshot = { items: [
  { workspaceId: 'native-dsh', path: '/work/dsh-plugin', title: 'dsh-plugin', sessionIds: ['native-1'] },
  { workspaceId: 'native-bridge', path: '/work/agent-bridge', title: 'agent-bridge', sessionIds: ['shared-id'] },
], archivedSessionIds: [], phase: 'ready' }
const nativeSessions = {
  list: { getSnapshot: () => nativeSnapshot, subscribe: () => () => {} },
  open: () => {}, create: async () => 'native-1',
}
const nativeWorkspaces = { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } }
let ready = false
function render() {
  if (!ready) return
  const footer = rows.find(row => row.name === 'sidebar.footer.action')!
  const overlay = rows.find(row => row.name === 'shell.overlay')!
  const sidebar = rows.find(row => row.name === 'sidebar.workspaces')
  const conversation = rows.find(row => row.name === 'conversation')
  root.render(<><div style={{ padding: 8 }}>Mock preview · built client bundle</div><div style={{ display: 'flex', height: 'calc(100vh - 40px)', color: '#e8edf5', background: '#111814' }}><aside style={{ width: 340, display: 'flex', flexDirection: 'column', minHeight: 0 }}><div style={{ flex: 1, minHeight: 0 }}>{sidebar ? <sidebar.component {...sidebar.inject()} wide={true} expandSidebar={() => {}} /> : <p>Native session browser placeholder</p>}</div><footer.component {...footer.inject()} wide={true} /></aside><main style={{ flex: 1, minWidth: 0 }}>{conversation ? <conversation.component {...conversation.inject()} /> : <p>Native conversation placeholder</p>}</main></div><overlay.component {...overlay.inject()} /></>)
}
const ctx = {
  layout: { closeDetails() {} },
  get: (name: string) => name === 'sessions' ? nativeSessions : name === 'workspaces' ? nativeWorkspaces : undefined,
  effect: (callback: () => unknown) => callback(),
  connection: { rpc: { call: async (_channel: string, _endpoint: string, payload: unknown) => {
    const response = await fetch('/__preview/dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    return response.json()
  } } },
  remote: { $on: () => () => {}, session: { modelCatalog: async () => ({ ok: true, value: {
    default: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    routableProviders: ['anthropic', 'shared-openai'],
    groups: [
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Shared DSH provider' }] },
      { id: 'shared-openai', name: 'Shared provider', models: [{ id: 'deepseek-v3.2', name: 'DeepSeek V3.2' }, { id: 'kimi-k2.5', name: 'Kimi K2.5' }] },
    ], failures: [],
  } }) } },
  slots: {
    inject: (_name: string, callback: () => void) => callback(),
    register: (options: { name: string; inject(): Record<string, unknown> }, component: React.ComponentType<any>) => { const row = { ...options, component }; rows.push(row); render(); return () => { rows.splice(rows.indexOf(row), 1); render() } },
  },
}
async function boot() {
  root.render(<p style={{ padding: 16 }}>Loading DSH surfaces…</p>)
  const [jsxRuntime, primitives, conversationUi, chat, modelSelection, workspaceUi] = await Promise.all([
    import('react/jsx-runtime'),
    import('@deepseek-ai/dsh-client-ui-primitives'),
    import('@deepseek-ai/dsh-client-ui-conversation/client'),
    import('@deepseek-ai/dsh-client-ui-chat/client'),
    import('@deepseek-ai/dsh-client-ui-model-selection/client'),
    import('@deepseek-ai/dsh-client-ui-workspace/client'),
  ])
  const staticModules: Record<string, unknown> = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-conversation/client': conversationUi,
    '@deepseek-ai/dsh-client-ui-chat/client': chat,
    '@deepseek-ai/dsh-client-ui-model-selection/client': modelSelection,
    '@deepseek-ai/dsh-client-ui-workspace/client': workspaceUi,
  }
  Object.assign(window, { __ModuleLoader__: { load: (registration: { id: string; factory(require: (id: string) => unknown): { apply(ctx: unknown): void } }) => {
    try {
      if (registration.id !== 'dsh-agent-control-plugin') throw new Error('Unexpected preview bundle')
      const plugin = registration.factory(id => { if (!(id in staticModules)) throw new Error(`Missing static module: ${id}`); return staticModules[id] })
      plugin.apply(ctx)
      ready = true
      const footer = rows.find(row => row.name === 'sidebar.footer.action')
      ;(footer?.inject()['controller'] as { open?(): void } | undefined)?.open?.()
      render()
    } catch (error) {
      showError('Plugin initialization failed', error)
    }
  } } })
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `/lib/client.js?preview=${Date.now()}`
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Build the plugin before opening this preview.'))
    document.head.append(script)
  })
}

void boot().catch(error => showError('Preview bootstrap failed', error))
