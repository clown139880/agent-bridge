import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Flush the new bytes before replacing the old sidecar; incomplete temp files are never loaded. */
export async function writeSyncSidecar(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + randomUUID()
  try {
    const handle = await open(temporary, 'wx')
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

/** Only this derived cache may be discarded. Aliases and deletion records retain their strict semantics. */
export async function readSyncVersions(path: string, warn: (message: string) => void): Promise<{ versions: Record<string, number>; recovered: boolean }> {
  let bytes: Buffer
  try { bytes = await readFile(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { versions: {}, recovered: false }
    throw error
  }
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(version => typeof version !== 'number' || !Number.isFinite(version) || version < 0)) {
      throw new SyntaxError('Invalid synchronization version cache')
    }
    return { versions: value as Record<string, number>, recovered: false }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const backup = path + '.corrupt-' + Date.now() + '-' + randomUUID() + '.bak'
    const handle = await open(backup, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() }
    finally { await handle.close() }
    warn(`Agent Bridge rebuilt corrupt synchronization cache: ${path}; original preserved at ${backup}`)
    return { versions: {}, recovered: true }
  }
}
