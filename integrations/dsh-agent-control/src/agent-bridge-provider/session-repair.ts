import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { JsonObject } from '../types.js'
import { conformToolResult, type ToolResultShape } from './dsh-compat.js'

/** The JSONL persistence backend seam used to find a stored log (DSH 0.1.5 and 0.1.7-rc.2). */
export interface LocatablePersistence {
  stat(id: string): Promise<unknown>
  locate?(header: unknown): { kind?: string; path?: string } | undefined
}

/**
 * Whether a resume failed because the stored log did not validate. A seq-level
 * validation error means this runtime refuses the whole session.
 */
export function isStoredSessionCorruption(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as { cause?: unknown }).cause, depth++) {
    if ((cause as { name?: unknown }).name === 'SessionPersistenceCorruptionError') return true
    if (/stored session "[^"]+" (?:is corrupt|failed validation)/.test(String((cause as { message?: unknown }).message ?? cause))) return true
  }
  return false
}

/**
 * Rewrite a stored Bridge session's own tool results into this runtime's
 * tool/result shape. DSH never rewrites committed events, so a log written by
 * a plugin that projected the other generation's shape (0.1.63 wrote role
 * "tool" on DSH 0.1.5) can only load again after this one-time conversion.
 * The original is kept under `backupRoot`. Returns the repaired seqs.
 */
export async function repairStoredToolResults(persistence: LocatablePersistence, id: string, shape: ToolResultShape, backupRoot: string): Promise<number[]> {
  const stat = await persistence.stat(id) as { header?: JsonObject } | undefined
  const path = stat?.header && persistence.locate?.(stat.header)?.path
  if (!path) return []
  const bytes = await readFile(path)
  const zstd = path.endsWith('.zstd')
  const chunks = zstd ? zstdFrames(bytes).map(frame => zstdDecompressSync(frame).toString('utf8')) : [bytes.toString('utf8')]
  const lines = chunks.join('').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const header = JSON.parse(lines[0] ?? '') as JsonObject
  if (header['type'] !== 'session' || header['id'] !== id) throw new Error(`stored session "${id}" has an unexpected header`)
  const repaired: number[] = []
  const events = lines.slice(1).map(line => {
    const event = JSON.parse(line) as JsonObject
    const data = event['data'] as JsonObject | undefined
    const message = event['type'] === 'tool/result' && data?.['message'] as JsonObject | undefined
    const conformed = message ? conformToolResult(message, shape) : undefined
    if (!conformed) return line
    repaired.push(Number(event['seq']))
    return JSON.stringify({ ...event, data: { ...data, message: conformed } })
  })
  if (!repaired.length) return []
  const backup = join(backupRoot, 'session-repairs', id)
  await mkdir(backup, { recursive: true })
  await copyFile(path, join(backup, Date.now() + '-' + basename(path)))
  // Header alone in the first frame: DSH lists sessions by decoding only that frame.
  const text = [lines[0] + '\n', events.map(line => line + '\n').join('')]
  const output = zstd ? Buffer.concat(text.map(part => zstdCompressSync(part, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))) : Buffer.from(text.join(''))
  // A noncanonical name is never selected as a session generation.
  const temporary = join(dirname(path), '.agent-bridge-repair.tmp')
  const handle = await open(temporary, 'w')
  try { await handle.writeFile(output); await handle.sync() }
  finally { await handle.close() }
  try { await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
  return repaired
}

/** Split a standard concatenation of Zstandard frames (skippable frames dropped). */
export function zstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    const magic = buffer.readUInt32LE(offset)
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { offset += 8 + buffer.readUInt32LE(offset + 4); continue }
    if (magic !== 0xFD2FB528) throw new Error(`not a Zstandard frame at byte ${start}`)
    const descriptor = buffer[offset + 4]!
    const singleSegment = (descriptor >> 5) & 1
    const contentSize = [singleSegment, 2, 4, 8][descriptor >> 6]!
    offset += 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + contentSize
    for (let last = 0; !last;) {
      if (offset + 3 > buffer.length) throw new Error(`truncated Zstandard frame at byte ${start}`)
      const block = buffer.readUIntLE(offset, 3)
      last = block & 1
      const type = (block >> 1) & 3
      if (type === 3) throw new Error(`reserved Zstandard block at byte ${offset}`)
      offset += 3 + (type === 1 ? 1 : block >>> 3)
    }
    offset += (descriptor >> 2) & 1 ? 4 : 0
    if (offset > buffer.length) throw new Error(`truncated Zstandard frame at byte ${start}`)
    frames.push(buffer.subarray(start, offset))
  }
  return frames
}
