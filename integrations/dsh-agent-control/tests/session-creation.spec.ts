import { describe, expect, it, vi } from 'vitest'
import { SessionCreationController } from '../src/client/session-creation.js'

describe('native directory creation', () => {
  it('lets the original action select a source and refreshes before returning its native identity', async () => {
    const source = {id:'remote',name:'Claude',workerId:'claude@machine',machineId:'machine',workspace:'/repo',available:true}
    const rpc = vi.fn(async (op: string) => op === 'creation_sources' ? {sources:[source]} : {nativeSessionId:'native-remote'})
    const controller = new SessionCreationController(rpc)
    const original = vi.fn(async (_options?: {workspaceId?:string}) => 'native-local')
    const sessions = {create:original,refresh:vi.fn(async () => {})}
    const dispose = controller.install(sessions,{list:{getSnapshot:() => ({items:[{id:'workspace',path:'/presentation'}]})}})
    const result = sessions.create({workspaceId:'workspace'} as never)
    await vi.waitFor(() => expect(controller.snapshot()).toBeDefined())
    controller.select(source)
    await expect(result).resolves.toBe('native-remote')
    expect(original).not.toHaveBeenCalled()
    expect(sessions.refresh).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenLastCalledWith('create_native',{cwd:'/presentation',sourceId:'remote'})
    dispose()
    expect(sessions.create).toBe(original)
  })
  it('preserves native DSH creation and cancels without creating a remote session', async () => {
    const local = {id:'dsh',name:'DSH',machineId:'local',workspace:'/local',available:true}
    const remote = {...local,id:'remote',workerId:'codex@machine'}
    const rpc = vi.fn(async () => ({sources:[local,remote]}))
    const controller = new SessionCreationController(rpc)
    const original = vi.fn(async (_options?: {cwd?:string}) => 'local')
    const sessions = {create:original,refresh:vi.fn(async () => {})}
    const dispose = controller.install(sessions,{list:{getSnapshot:() => ({items:[]})}})
    const created = sessions.create({cwd:'/local'})
    await vi.waitFor(() => expect(controller.snapshot()).toBeDefined())
    controller.select(local)
    await expect(created).resolves.toBe('local')
    expect(original).toHaveBeenCalledWith({cwd:'/local'})
    const cancelled = sessions.create({cwd:'/local'})
    const rejection = expect(cancelled).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(controller.snapshot()).toBeDefined())
    controller.cancel()
    await rejection
    expect(rpc).toHaveBeenCalledTimes(2)
    dispose()
  })
})
