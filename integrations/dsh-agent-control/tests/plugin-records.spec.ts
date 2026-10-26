import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { isBridgeRecord, BINDING_EVENT, ACK_EVENT } from '../src/agent-bridge-provider/records.js'
const { repair } = createRequire(import.meta.url)('../scripts/repair-v3-plugin-records.cjs') as { repair(rows: Record<string, unknown>[]): Record<string, unknown>[] }
const { repairStaleFinalStep } = createRequire(import.meta.url)('../scripts/repair-v3-plugin-records.cjs') as { repairStaleFinalStep(rows: Record<string, unknown>[]): Record<string, unknown>[] }
const { plan } = createRequire(import.meta.url)('../scripts/repair-v3-structure.cjs') as { plan(rows: any[]): { rows: any[]; mapping: number[]; changes: any[] } }

it('adds a protected empty head, remaps title references and preserves every original message', () => {
  const rows = [
    { type: 'session', version: 3, id: 'agent-bridge-structural', isSeeded: false },
    { type: BINDING_EVENT, seq: 0, time: 1, data: {} },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 3, time: 1, surfaceOp: 'append', data: { id: 'u', content: [{ type: 'text', text: 'original' }] } },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/start', seq: 5, time: 2, data: { turn: 2 } },
    { type: 'turn/end', seq: 6, time: 2, data: { turn: 2 } },
    { type: 'session/title', seq: 7, time: 2, data: { messageSeqs: [3] } },
  ]
  const original = structuredClone(rows), output = plan(rows)
  expect(rows).toEqual(original)
  expect(output.rows[4]).toMatchObject({ type: 'system/message', data: { message: { content: [] } } })
  expect(output.rows[output.mapping[3]! + 1].data).toEqual(rows[4]!.data)
  expect(output.rows.at(-1).data.messageSeqs).toEqual([output.mapping[3]])
  expect(output.changes.some(change => change.kind === 'interrupted-turn-end')).toBe(true)
  expect(plan(output.rows).rows).toEqual(output.rows)
  expect(() => plan([{ ...rows[0], isSeeded: true }, ...rows.slice(1)])).toThrow('Fork')
  expect(() => plan([...rows, { type: 'new/event', seq: 8, data: {} }])).toThrow('Unaudited')
})

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
