import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeSyncSidecar } from '../src/agent-bridge-provider/sync-version-cache.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('replaces a sidecar atomically and leaves no temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-sidecar-')); roots.push(root)
  const path = join(root, 'nested', 'record.json')
  await writeSyncSidecar(path, { session: 1 })
  await writeSyncSidecar(path, { session: 123 })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ session: 123 })
  expect(await readdir(join(root, 'nested'))).toEqual(['record.json'])
})
