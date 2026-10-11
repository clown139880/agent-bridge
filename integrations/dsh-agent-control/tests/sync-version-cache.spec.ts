import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readSyncVersions, writeSyncSidecar } from '../src/agent-bridge-provider/sync-version-cache.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-sync-cache-')); roots.push(root)
  return { root, path: join(root, 'synced-versions.json') }
}

it('preserves an all-NUL corrupt cache and allows it to be rebuilt', async () => {
  const { root, path } = await fixture(), original = Buffer.alloc(22219), warn = vi.fn()
  await writeFile(path, original)
  expect(await readSyncVersions(path, warn)).toEqual({ versions: {}, recovered: true })
  const backup = (await readdir(root)).find(name => name.endsWith('.bak'))!
  expect(await readFile(join(root, backup))).toEqual(original)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(backup))
  await writeSyncSidecar(path, { session: 123 })
  expect(await readSyncVersions(path, warn)).toEqual({ versions: { session: 123 }, recovered: false })
  expect((await readdir(root)).filter(name => name.includes('.tmp'))).toEqual([])
})

it.each(['', '{"session":', 'null', '[]', '{"session":"123"}'])('rebuilds invalid cache %j without losing its original bytes', async text => {
  const { root, path } = await fixture()
  await writeFile(path, text)
  expect((await readSyncVersions(path, vi.fn())).recovered).toBe(true)
  const backup = (await readdir(root)).find(name => name.endsWith('.bak'))!
  expect(await readFile(join(root, backup), 'utf8')).toBe(text)
})

it('loads BOM-prefixed JSON and distinguishes a missing cache from corruption', async () => {
  const { path } = await fixture(), warn = vi.fn()
  expect(await readSyncVersions(path, warn)).toEqual({ versions: {}, recovered: false })
  await writeFile(path, '\uFEFF{"session":123}')
  expect(await readSyncVersions(path, warn)).toEqual({ versions: { session: 123 }, recovered: false })
  expect(warn).not.toHaveBeenCalled()
})
