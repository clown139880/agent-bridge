import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { migrate } = require('../scripts/migrate-v2-history.cjs') as { migrate(rows: unknown[]): Record<string, unknown>[] }

const header = { type: 'session', version: 2, id: 'agent-bridge-session', createdAt: 1, isSeeded: false, delegationDepth: 0, agentPreset: 'agent-bridge' }
const event = (type: string, seq: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type, seq, time: 100 + seq, data, ...extra })

describe('Agent Bridge V2 history migration', () => {
  it('retains plugin metadata, promotes a system head and remaps title references', () => {
    const rows = [
      header,
      event('agent-bridge/binding', 0, { sessionId: 'remote', workerId: 'worker', workspace: '/repo', origin: 'http://bridge' }),
      event('turn/start', 1, { turn: 1 }),
      event('step/start', 2, { turn: 1, step: 1 }),
      event('user/message', 3, { id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, { surfaceOp: 'append' }),
      event('step/end', 4, { turn: 1, step: 1 }),
      event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
      event('agent-bridge/event', 6, { eventId: 'event', turnId: 'turn' }),
      event('session/title', 7, { title: 'History', messageSeqs: [3], source: { kind: 'user' } }),
    ]
    const binding = rows[1] as ReturnType<typeof event>
    const acknowledgement = rows[7] as ReturnType<typeof event>
    const result = migrate(rows)
    expect(result[0]).toMatchObject({ version: 3, id: header.id })
    expect(result.slice(1).map(row => row.type)).toEqual([
      'agent-bridge/binding', 'turn/start', 'step/start', 'system/message', 'user/message',
      'step/end', 'turn/end', 'agent-bridge/event', 'session/title',
    ])
    expect(result[1]).toMatchObject({ seq: 0, ignorable: true, data: binding.data })
    expect(result[4]).toMatchObject({ seq: 3, surfaceOp: 'append' })
    expect(result[8]).toMatchObject({ ignorable: true, data: acknowledgement.data })
    expect(result[9]).toMatchObject({ data: { messageSeqs: [4] } })
    expect(rows[0]).toEqual(header)
  })

  it('promotes request system text and uses V3 replacement coordinates', () => {
    const result = migrate([
      header,
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { config: { provider: 'agent-bridge', model: 'remote' }, system: 'prompt' }, reason: 'initial' }),
      event('step/end', 3, { turn: 1, step: 1 }),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const systems = result.filter(row => row.type === 'system/message')
    expect(systems).toHaveLength(2)
    expect(systems[1]).toMatchObject({
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
      data: { message: { content: [{ type: 'text', text: 'prompt' }] } },
    })
    const request = result.find(row => row.type === 'request/header') as { data: { header: object } }
    expect(request.data.header).not.toHaveProperty('system')
  })

  it('refuses unknown events and malformed bridge acknowledgements', () => {
    expect(() => migrate([header, event('external/event', 0, {})])).toThrow('unclassified event external/event')
    expect(() => migrate([header, event('agent-bridge/event', 0, { eventId: 'event', turnId: 1 })])).toThrow('identities must be strings')
  })
})
