import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBridgeStream } from '../src/client/bridge-stream.js'

const frame = (type: string, seq: number) => `id: c:0:${seq}\nevent: bridge.event\ndata: ${JSON.stringify({
  cursor: `c:0:${seq}`, eventId: `change:${seq}`, type, timestamp: 1, resource: { kind: 'run', id: 'r' }, sessionId: null, data: {},
})}\n\n`

describe('openBridgeStream', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('skips well-formed events of types this client does not consume', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://dsh.local' } })
    vi.stubGlobal('fetch', async () => new Response(`retry: 3000\n\n${frame('run.upserted', 1)}${frame('worker.offline', 2)}`))
    const types = []
    for await (const event of openBridgeStream(undefined, new AbortController().signal)) types.push(event.type)
    expect(types).toEqual(['worker.offline'])
  })
})
