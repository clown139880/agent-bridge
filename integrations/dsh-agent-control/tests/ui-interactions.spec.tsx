// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionCreationController, SessionSourcePicker } from '../src/client/session-creation.js'
import { Overview, Tasks } from '../src/client/index.js'
import { useDialog } from '../src/client/dialog.js'

let container: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const click = async (element: Element) => act(async () => { (element as HTMLElement).click() })
const change = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('management UI interactions', () => {
  it('requires an explicit create action, rejects offline choices, and cancels with Escape', async () => {
    const sources = [
      {id:'codex', name:'Codex @ wsl', machineId:'wsl', workspace:'/repo', available:true},
      {id:'claude', name:'Claude @ wsl', machineId:'wsl', workspace:'/repo', available:true},
      {id:'offline', name:'Offline', machineId:'hal', workspace:'/repo', available:false},
    ]
    const rpc = vi.fn(async (op: string) => op === 'creation_sources' ? { sources } : {nativeSessionId:'created'})
    const controller = new SessionCreationController(rpc)
    const sessions = {create:async (_options?:{cwd?:string}) => 'local',refresh:async () => {}}
    const dispose = controller.install(sessions,{list:{getSnapshot:() => ({items:[]})}})
    await act(async () => root.render(<SessionSourcePicker controller={controller} />))
    let creation!: Promise<string>
    await act(async () => { creation = sessions.create({cwd:'/repo'}) })
    const radios = container.querySelectorAll<HTMLInputElement>('input[type=radio]')
    expect(radios[2]!.disabled).toBe(true)
    await click(radios[1]!)
    expect(rpc).toHaveBeenCalledTimes(1)
    await click([...container.querySelectorAll('button')].find(button => button.textContent?.includes('创建对话'))!)
    await expect(creation).resolves.toBe('created')
    expect(rpc).toHaveBeenLastCalledWith('create_native',{cwd:'/repo',sourceId:'claude'})
    let cancelled!: Promise<string>
    await act(async () => { cancelled = sessions.create({cwd:'/repo'}); void cancelled.catch(() => {}) })
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(container.querySelector('[role=dialog]')).toBeNull()
    dispose()
  })

  it('filters the board and closes only the nested dialog, returning focus to its trigger', async () => {
    const closed = vi.fn()
    function Harness() { const ref = useDialog(true,closed); return <div ref={ref}><Tasks snapshot={{board:{assignees:['Ada'],columns:[{name:'todo',tasks:[{id:'T1',title:'Fix long workspace names',assignee:'Ada'}]},{name:'done',tasks:[{id:'T2',title:'Deploy release'}]}]}}} refresh={async () => {}} openSession={() => {}} /></div> }
    await act(async () => root.render(<Harness />))
    await change(container.querySelector<HTMLInputElement>('input[type=search]')!, 'workspace')
    expect(container.textContent).toContain('Fix long workspace names')
    expect(container.textContent).not.toContain('Deploy release')
    const trigger = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建任务'))!
    trigger.focus(); await click(trigger)
    expect(container.querySelector('[aria-label="新建任务"]')).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    expect(closed).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="新建任务"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await change(container.querySelector<HTMLInputElement>('input[type=search]')!, 'does-not-exist')
    expect(container.textContent).toContain('没有匹配的任务')
  })

  it('shows online versions first and makes recent conversations navigable', async () => {
    const open = vi.fn()
    await act(async () => root.render(<Overview data={{sessionProvider:{registered:true,nativeSessions:2},bridge:{workers:[{id:'old',name:'Offline machine',status:'offline'},{id:'live',name:'Live machine',status:'online',bridgeVersion:'0.6.36'}],sessions:[{sessionId:'remote',title:'Continue work',status:'idle'}]}}} openSession={open} />))
    expect(container.textContent).not.toContain('Offline machine')
    expect(container.textContent).toContain('0.6.36')
    expect([...container.querySelectorAll('button')].filter(b => b.textContent === '删除')).toHaveLength(0)
    await click(container.querySelector('input[type=checkbox]')!)
    const deletes = [...container.querySelectorAll('button')].filter(b => b.textContent === '删除')
    expect(deletes).toHaveLength(1)
    await click(deletes[0]!)
    expect(container.querySelector('[role=dialog]')?.textContent).toContain('全部 0 个会话')
    await click([...container.querySelectorAll('button')].find(b => b.textContent === '取消')!)
    expect(container.querySelector('[role=dialog]')).toBeNull()
    expect(container.textContent).toContain('Offline machine')
    await click([...container.querySelectorAll('button')].find(button => button.textContent?.includes('Continue work'))!)
    expect(open).toHaveBeenCalledWith('remote')
  })
})
