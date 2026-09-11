// @vitest-environment jsdom
import { act, createElement } from 'react'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { existsSync, readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { extendSessionMenu, installSessionMenu } from '../src/client/session-menu.js'
import { DeleteNativeSession, NativeCatalog } from '../src/client/native-catalog.js'

it('extends the actual DSH menu and targets an unselected local session', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const relative = 'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js'
  const source = readFileSync(existsSync(relative) ? relative : 'integrations/dsh-agent-control/' + relative, 'utf8').replace('return module.exports;', 'module.exports.TestRow = SessionNodeItem; return module.exports;')
  let exports: any
  const primitives = new Proxy({ relativeTime: () => ({unit: 'now', value: 0}), HoverCard: ({ anchor }: any) => anchor, Menu: ({ anchor, open, items, onSelect }: any) => <>{anchor}{open && items.map((i: any) => <button key={i.id} onClick={() => onSelect(i.id)}>{i.label}</button>)}</> }, { get: (target, key) => Reflect.get(target, key) ?? (() => null) })
  const require = (id: string) => id === 'react' ? React : id === 'react/jsx-runtime' ? jsx : id.endsWith('primitives') ? primitives : id.endsWith('cordis') ? { Service: class {} } : {}
  new Function('window', source)({ __ModuleLoader__: { load: ({ factory }: any) => { exports = factory(require) } } })
  const rpc = vi.fn(async () => ({ deleted: true })), clear = vi.fn(), refresh = vi.fn(async () => {})
  const catalog = new NativeCatalog(rpc, { list: { getSnapshot: () => ({ current: 'different' }), subscribe: () => () => {} }, clear, refresh })
  const archive = vi.fn()
  const Browser = extendSessionMenu(() => createElement(exports.TestRow, { node: { id: 'session-local', title: '本地对话', status: 'idle', descendants: [], pendingInteractions: [], createdAt: Date.now(), updatedAt: Date.now() }, currentId: 'different', now: Date.now(), onOpen: vi.fn(), onRename: vi.fn(), onFork: vi.fn(), onArchive: archive, t: (key: string) => key }))
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div)
  const click = async (text: string) => act(async () => { [...div.querySelectorAll('button')].find(b => b.textContent === text)!.click() })
  const menu = async () => act(async () => { div.querySelector<HTMLButtonElement>('button[aria-label]')!.click() })
  try {
    await act(async () => root.render(<><Browser /><DeleteNativeSession catalog={catalog} /></>))
    await menu(); await click('删除会话')
    expect(div.querySelector('[role=dialog]')?.textContent).toContain('本地对话')
    await click('取消'); expect(rpc).not.toHaveBeenCalled()
    await menu(); await click('删除会话'); await click('确认删除')
    expect(rpc).toHaveBeenCalledWith('delete_native', { nativeId: 'session-local' })
    expect(clear).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalled()
    await menu(); await click('menu.archiveSession'); expect(archive).toHaveBeenCalledWith('session-local')
  } finally { await act(async () => root.unmount()); div.remove() }
})
it('restores the native component on unload', () => {
  const original = () => null; const entry = { component: original }; const stop = vi.fn()
  const dispose = installSessionMenu({ entries: () => [entry], subscribe: () => stop })
  expect(entry.component).not.toBe(original); dispose(); expect(entry.component).toBe(original); expect(stop).toHaveBeenCalled()
})


