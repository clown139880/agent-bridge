import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { isBridgeRecord, BINDING_EVENT, ACK_EVENT } from '../src/agent-bridge-provider/records.js'
const { repair } = createRequire(import.meta.url)('../scripts/repair-v3-plugin-records.cjs') as { repair(rows: Record<string, unknown>[]): Record<string, unknown>[] }
const { repairStaleFinalStep } = createRequire(import.meta.url)('../scripts/repair-v3-plugin-records.cjs') as { repairStaleFinalStep(rows: Record<string, unknown>[]): Record<string, unknown>[] }

it('repairs only a stale final answer/closure pair and preserves identities and references', () => {
  const event = (type: string, data: object, seq: number) => ({ type, data, seq, time: 100 + seq })
  const rows = [
    { type: 'session', version: 3 },
    event('turn/start', { turn: 1 }, 0),
    event('step/start', { turn: 1, step: 1 }, 1),
    event('step/end', { turn: 1, step: 1 }, 2),
    event('step/start', { turn: 1, step: 38 }, 3),
    event(ACK_EVENT, { eventId: 'remote' }, 4),
    event('assistant/message', { turn: 1, step: 1, message: { id: 'answer', source: { kind: 'model', provider: 'agent-bridge' }, content: [{ type: 'text', text: 'retained' }] } }, 5),
    event('step/end', { turn: 1, step: 1 }, 6),
    event('turn/end', { turn: 1 }, 7),
    event('session/title', { messageSeqs: [5] }, 8),
  ]
  const fixed = repairStaleFinalStep(rows)
  expect(fixed[6]).toEqual({ ...rows[6], data: { ...(rows[6] as { data: object }).data, step: 38 } })
  expect(fixed[7]).toEqual({ ...rows[7], data: { turn: 1, step: 38 } })
  expect(fixed.filter((row, i) => row !== rows[i])).toHaveLength(2)
  expect(repairStaleFinalStep(fixed)).toEqual(fixed)
  expect(() => repairStaleFinalStep(rows.slice(0, 8))).toThrow('Ambiguous')
  const occupied = rows.slice(); occupied[5] = event('user/message', {}, 4)
  expect(() => repairStaleFinalStep(occupied)).toThrow('Ambiguous')
})

it('recognizes historical and V4 records without admitting other plugin types', () => {
  expect(isBridgeRecord('plugin:' + BINDING_EVENT, BINDING_EVENT)).toBe(true)
  expect(isBridgeRecord(BINDING_EVENT, BINDING_EVENT)).toBe(true)
  expect(isBridgeRecord('plugin:' + ACK_EVENT, BINDING_EVENT)).toBe(false)
  expect(isBridgeRecord('plugin:unrelated/event')).toBe(false)
})

it('repairs only Bridge envelopes, preserving all coordinates, data and unrelated events', () => {
  const header = { type: 'session', version: 3, id: 'agent-bridge-test' }
  const binding = { type: BINDING_EVENT, seq: 0, time: 100, data: { sessionId: 'remote' } }
  const message = { type: 'user/message', seq: 1, time: 101, data: { content: ['retained'] }, surfaceOp: 'append' }
  const ack = { type: ACK_EVENT, seq: 2, time: 102, data: { eventId: 'event', turnId: 'turn' } }
  const rows = [header, binding, message, ack]
  const output = repair(rows)
  expect(output).toEqual([header, { ...binding, ignorable: true }, message, { ...ack, ignorable: true }])
  expect(output[2]).toBe(message)
  expect(binding).not.toHaveProperty('ignorable')
  expect(repair(output)).toEqual(output)
  expect(() => repair([{ ...header, version: 4 }, binding])).toThrow('V3')
  expect(() => repair([header, { ...binding, seq: 3 }])).toThrow('Non-dense')
  expect(() => repair([header, { ...binding, surfaceOp: 'append' }])).toThrow('envelope')
  expect(() => repair([header, binding, { ...ack, seq: 1, data: {} }])).toThrow('identity')
})
