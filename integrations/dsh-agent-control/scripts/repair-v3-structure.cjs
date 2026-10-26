const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { repair, repairStaleFinalStep } = require('./repair-v3-plugin-records.cjs');

const known = new Set(['agent-bridge/binding', 'agent-bridge/event', 'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'system/message', 'session/title', 'session/end-seed', 'permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection', 'agent/inbox/spliced', 'request/header', 'request/context']);
const surface = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message']);

function plan(rows, v4 = false) {
  if (rows[0].isSeeded !== false || rows[0].parentSession) throw new Error('Fork lineage requires separate migration');
  let input;
  if (v4) {
    if (rows[0].type !== 'session' || rows[0].version !== 4 || !rows[0].id?.startsWith('agent-bridge-')) throw new Error('Expected Bridge V4');
    if (!rows.some(e => e.type === 'plugin:agent-bridge/binding' && e.ignorable === true)) throw new Error('Missing V4 binding');
    rows.slice(1).forEach((e, seq) => { if (e.seq !== seq) throw new Error('Non-dense event sequence'); });
    input = rows;
  } else input = repairStaleFinalStep(repair(rows));
  const events = [], mapping = [], changes = [];
  for (let i = 1; i < input.length; i++) if (input[i].data.step !== rows[i].data.step) {
    changes.push({ seq: rows[i].seq, field: 'step', from: rows[i].data.step, to: input[i].data.step });
  }
  let turn, sourceTurn, step, count = 0, head = false;
  const ref = value => {
    if (!Number.isSafeInteger(value) || mapping[value] === undefined) throw new Error('Unknown or forward sequence reference');
    return mapping[value];
  };
  for (const original of input.slice(1)) {
    if (!known.has(original.type) && !(v4 && ['plugin:agent-bridge/binding', 'plugin:agent-bridge/event'].includes(original.type) && original.ignorable === true)) throw new Error('Unaudited event type: ' + original.type);
    const event = structuredClone(original);
    // Payloads are opaque except the documented title references and lifecycle
    // coordinates. Refuse future embedded seq references rather than guess.
    const inspect = (value, location = '') => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/seq|offset/i.test(key) && !(event.type === 'session/title' && location === '' && key === 'messageSeqs')) throw new Error('Unaudited payload reference: ' + key);
        // Request tool schemas describe user arguments, not event references.
        if (event.type === 'request/header' && location === '.header' && key === 'tools') continue;
        inspect(child, location + '.' + key);
      }
    };
    inspect(event.data);
    if (event.type === 'turn/start') {
      if (turn !== undefined) {
        if (step !== undefined || event.data.turn !== sourceTurn + 1) throw new Error('Ambiguous overlapping turn at seq ' + event.seq);
        events.push({ type: 'turn/end', seq: events.length, time: event.time, data: { turn, reason: { kind: 'interrupted' } } });
        changes.push({ beforeSeq: event.seq, kind: 'interrupted-turn-end', turn });
      }
      sourceTurn = event.data.turn; turn = ++count;
    }
    if (event.data.turn !== undefined) {
      if (event.data.turn !== sourceTurn || turn === undefined) throw new Error('Ambiguous lifecycle coordinate at seq ' + event.seq);
      if (event.data.turn !== turn) changes.push({ seq: event.seq, field: 'turn', from: event.data.turn, to: turn });
      event.data.turn = turn;
    }
    if (event.type === 'step/start') step = event.data.step;
    if (!head && surface.has(event.type)) {
      if (event.type === 'system/message') head = true;
      else {
        if (turn === undefined || step === undefined) throw new Error('First surface has no open step');
        const id = 'bridge-system-head-' + createHash('sha256').update(rows[0].id).digest('hex');
        if (input.some(row => row.data?.message?.id === id || row.data?.id === id)) throw new Error('System head identity collision');
        events.push({ type: 'system/message', seq: events.length, time: event.time, surfaceOp: 'append', data: { turn, step, message: { id, role: 'system', source: v4 ? { kind: 'system-prompt' } : { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [] } } });
        changes.push({ beforeSeq: event.seq, kind: 'empty-system-head' });
        head = true;
      }
    }
    if (event.type === 'session/title') event.data.messageSeqs = event.data.messageSeqs.map(ref);
    if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(ref);
    if (event.surfaceOp && event.surfaceOp !== 'append') {
      if (event.type !== 'system/message' || event.surfaceOp.op !== 'replace') throw new Error('Unaudited surface replacement');
      event.surfaceOp.startSeq = ref(event.surfaceOp.startSeq); event.surfaceOp.endSeq = ref(event.surfaceOp.endSeq);
    }
    mapping[original.seq] = events.length;
    event.seq = events.length;
    events.push(event);
    if (event.type === 'step/end') step = undefined;
    if (event.type === 'turn/end') { turn = undefined; sourceTurn = undefined; step = undefined; }
  }
  // Every original message object survives byte-for-byte at its mapped event.
  for (const event of input.slice(1)) {
    const next = events[mapping[event.seq]];
    if (event.data.message) assert.deepEqual(next.data.message, event.data.message);
    if (event.type === 'user/message') assert.deepEqual(next.data, event.data);
  }
  if (v4 && changes.some(change => change.kind !== 'empty-system-head')) throw new Error('V4 head repair cannot alter lifecycle coordinates');
  return { rows: [input[0], ...events], mapping, changes };
}
module.exports = { plan };
