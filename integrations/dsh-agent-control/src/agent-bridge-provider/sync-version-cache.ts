import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
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
