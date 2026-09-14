// Run with Node 24+ while TokensCowork is stopped. Dry-run unless --apply is passed.
// Publishes an immutable V3 successor for Agent Bridge V2 logs without changing V2.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');
const { createHash } = require('node:crypto');

const BRIDGE_TYPES = new Set(['agent-bridge/binding', 'agent-bridge/event']);
const AUDITED_V2_TYPES = new Set([
  'agent/inbox/spliced', 'approval/policy', 'assistant/attempt', 'assistant/message',
  'command/done', 'command/run', 'model/selection', 'permission/preset',
  'request/context', 'request/header', 'sandbox/mode', 'session/end-seed',
  'session/title', 'step/end', 'step/start', 'tool/call', 'tool/result',
  'turn/end', 'turn/start', 'user/message',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a non-negative safe integer');
  return value;
}

function exactKeys(value, required, optional, label) {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(label + ' lacks required field ' + key);
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) throw new Error(label + ' has unexpected field ' + unexpected);
}

function validateBridgeEvent(event) {
  exactKeys(event, ['type', 'seq', 'time', 'data'], ['ignorable'], event.type);
  if (event.ignorable !== undefined && event.ignorable !== true) throw new Error(event.type + ' ignorable must be true');
  const data = record(event.data, event.type + ' data');
  if (event.type === 'agent-bridge/event') {
    exactKeys(data, ['eventId', 'turnId'], [], event.type + ' data');
    if (typeof data.eventId !== 'string' || typeof data.turnId !== 'string') throw new Error(event.type + ' identities must be strings');
    return;
  }
  for (const key of ['sessionId', 'workerId', 'workspace', 'origin']) {
    if (typeof data[key] !== 'string' || data[key].length === 0) throw new Error(event.type + ' data requires string ' + key);
  }
}

function remapEvent(event, seq, mapping) {
  const one = value => {
    const source = count(value, 'source event reference');
    if (source >= event.seq || mapping[source] === undefined) throw new Error('reference must name an earlier source event');
    return mapping[source];
  };
  const list = value => {
    if (!Array.isArray(value)) throw new Error('sequence references must be an array');
    return value.map(one);
  };
  const range = value => {
    const source = record(value, 'sequence range');
    return { ...source, startSeq: one(source.start), endSeq: one(source.end) };
  };
  let data = record(event.data, event.type);
  if (event.type === 'command/done' && data.sourceEventSeq !== undefined) data = { ...data, sourceEventSeq: one(data.sourceEventSeq) };
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') data = {
    ...data,
    shadowedRange: range(data.shadowedRange),
    shadowedSeqs: list(data.shadowedSeqs),
  };
  if (event.type === 'session/title' || event.type === 'session/title-llm-request') data = { ...data, messageSeqs: list(data.messageSeqs) };
  return {
    ...event,
    seq,
    data,
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: list(event.sourceEventSeqs) }),
    ...(event.surfaceOp === undefined || event.surfaceOp === 'append' ? {} : { surfaceOp: range(event.surfaceOp) }),
  };
}

function messages(event) {
  const data = record(event.data, event.type + ' data');
  if (event.type === 'user/message') return [data];
  if (event.type === 'assistant/message' || event.type === 'tool/result') return [record(data.message, event.type + ' message')];
  if (event.type === 'agent/inbox/spliced') return data.inserted;
  if (event.type === 'session/title-llm-request') return data.messages;
  return [];
}

function migrate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Session log is empty');
  const header = record(rows[0], 'Session header');
  if (header.type !== 'session' || header.version !== 2 || typeof header.id !== 'string' || !header.id.startsWith('agent-bridge-')) {
    throw new Error('Only Agent Bridge format V2 Sessions are supported');
  }
  if (header.isSeeded !== false) throw new Error('Seeded Agent Bridge V2 Sessions require a separate migration audit');
  const source = rows.slice(1);
  const mapping = [];
  const output = [];
  const originalIds = new Set();
  const generatedIds = new Set();
  let step;
  let head;
  let prompt = '';

  const emitSystem = (nextPrompt, anchor) => {
    if (!step) throw new Error('format V2 changed request prompt outside an open step');
    const identity = JSON.stringify(['session-format-v2-to-v3', header.id, anchor.seq, anchor.type]);
    const id = 'v2-to-v3-system-' + createHash('sha256').update(identity).digest('hex');
    if (originalIds.has(id) || generatedIds.has(id)) throw new Error('generated system message id collides with an existing message id');
    generatedIds.add(id);
    const seq = output.length;
    output.push({
      type: 'system/message', seq, time: anchor.time,
      data: { ...step, message: {
        id, role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        content: nextPrompt === '' ? [] : [{ type: 'text', text: nextPrompt }],
      } },
      ...(head === undefined
        ? { surfaceOp: 'append' }
        : { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] }),
    });
    head = seq;
    prompt = nextPrompt;
  };

  for (const eventValue of source) {
    const event = record(eventValue, 'Session event');
    if (event.seq !== mapping.length) throw new Error('format V2 source events must be dense');
    count(event.time, event.type + ' time');
    if (BRIDGE_TYPES.has(event.type)) validateBridgeEvent(event);
    else if (!AUDITED_V2_TYPES.has(event.type)) throw new Error('cannot safely transform unclassified event ' + event.type);
    for (const message of messages(event)) {
      const value = record(message, event.type + ' message');
      if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(event.type + ' message requires an id');
      if (generatedIds.has(value.id)) throw new Error('source message id collides with a generated system message id');
      originalIds.add(value.id);
    }
    let transformed = event;
    if (event.type === 'request/header') {
      const data = record(event.data, 'request/header data');
      const request = record(data.header, 'request header');
      const nextPrompt = typeof request.system === 'string' ? request.system : '';
      if (nextPrompt !== prompt) emitSystem(nextPrompt, event);
      const { system: _system, ...withoutSystem } = request;
      transformed = { ...event, data: { ...data, header: withoutSystem } };
    }
    const target = remapEvent(transformed, output.length, mapping);
    mapping.push(output.length);
    output.push(BRIDGE_TYPES.has(event.type) ? { ...target, ignorable: true } : target);
    if (event.type === 'step/start') {
      const data = record(event.data, 'step/start data');
      step = { turn: data.turn, step: data.step };
      if (head === undefined) emitSystem('', event);
    } else if (event.type === 'step/end' || event.type === 'turn/end') step = undefined;
  }
  return [{ ...header, version: 3 }, ...output];
}

function decodeFile(file) {
  let bytes = fs.readFileSync(file);
  if (!/\.zstd(?:\.migrating)?$/.test(file)) return bytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  let text = '';
  while (bytes.length) {
    const frame = zlib.zstdDecompressSync(bytes, { info: true });
    text += frame.buffer.toString('utf8');
    bytes = bytes.subarray(frame.engine.bytesWritten);
  }
  return text.trim().split(/\r?\n/).map(JSON.parse);
}

function encodeRows(rows, compressed) {
  const lines = rows.map(row => JSON.stringify(row) + '\n');
  return compressed ? Buffer.concat(lines.map(line => zlib.zstdCompressSync(Buffer.from(line)))) : Buffer.from(lines.join(''));
}

function run(argv = process.argv.slice(2)) {
  const root = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const sessions = path.join(root, 'sessions');
  const apply = argv.includes('--apply');
  let candidates = 0;
  let migrated = 0;
  for (const relative of fs.readdirSync(sessions, { recursive: true })) {
    if (!relative.endsWith('session.v2.jsonl.zstd') && !relative.endsWith('session.v2.jsonl')) continue;
    const file = path.join(sessions, relative);
    const rows = decodeFile(file);
    if (!rows[0]?.id?.startsWith('agent-bridge-') || !rows.some(row => row.type === 'agent-bridge/binding')) continue;
    const target = file.replace('session.v2.jsonl', 'session.v3.jsonl');
    if (fs.existsSync(target)) continue;
    const transformed = migrate(rows);
    candidates += 1;
    console.log((apply ? 'MIGRATE ' : 'WOULD MIGRATE ') + rows[0].id);
    if (!apply) continue;
    const temporary = target + '.migrating';
    fs.writeFileSync(temporary, encodeRows(transformed, target.endsWith('.zstd')), { flag: 'wx' });
    try {
      if (JSON.stringify(decodeFile(temporary)) !== JSON.stringify(transformed)) throw new Error('V3 successor verification failed for ' + rows[0].id);
      // A hard-link publication is atomic and refuses to replace a concurrently created V3.
      fs.linkSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    migrated += 1;
  }
  console.log((apply ? 'Published ' + migrated : 'Ready to publish ' + candidates) + ' V3 successor(s); every V2 source remains unchanged.');
  return migrated;
}

module.exports = { migrate, decodeFile, encodeRows, run };
if (require.main === module) run();
