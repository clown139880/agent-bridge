// Run with Node 24+ while TokensCowork is stopped. Dry-run unless --apply is passed.
// Retains every event and sequence, changing only colliding presentation identities.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');

function repair(events) {
  const result = structuredClone(events);
  let maximum = 0, sourceTurn = -1, logTurn = -1;
  const calls = new Set(), remap = new Map();
  for (const event of result) {
    const data = event.data;
    if (!data) continue;
    if (event.type === 'turn/start') {
      sourceTurn = data.turn;
      logTurn = Math.max(maximum + 1, sourceTurn);
      maximum = logTurn;
    }
    if (data.turn === sourceTurn) data.turn = logTurn;
    if (event.type === 'assistant/message') for (const block of data.message?.content ?? []) {
      if (block.type !== 'tool-call') continue;
      const old = block.id;
      const next = calls.has(old) ? old + ':repair:' + event.seq : old;
      calls.add(old);
      remap.set(old, next);
      block.id = next;
    }
    if (event.type === 'tool/call' && remap.has(data.callId)) data.callId = remap.get(data.callId);
    if (event.type === 'tool/result') {
      const message = data.message;
      if (remap.has(message?.source?.callId)) message.source.callId = remap.get(message.source.callId);
      for (const block of message?.content ?? []) if (block.type === 'tool-result' && remap.has(block.toolCallId)) block.toolCallId = remap.get(block.toolCallId);
    }
  }
  return result;
}
module.exports = { repair };

if (require.main === module) {
  const root = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const sessions = path.join(root, 'sessions');
  const backup = path.join(root, 'agent-bridge', 'identity-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const relative of fs.readdirSync(sessions, { recursive: true })) {
    if (!relative.endsWith('session.v2.jsonl.zstd') && !relative.endsWith('session.v2.jsonl')) continue;
    const file = path.join(sessions, relative);
    const compressed = file.endsWith('.zstd');
    const original = fs.readFileSync(file);
    let text = '';
    if (compressed) {
      let bytes = original;
      while (bytes.length) {
        const frame = zlib.zstdDecompressSync(bytes, { info: true });
        text += frame.buffer.toString('utf8');
        bytes = bytes.subarray(frame.engine.bytesWritten);
      }
    } else text = original.toString('utf8');
    const rows = text.trim().split('\n').map(JSON.parse);
    if (!rows[0]?.id?.startsWith('agent-bridge-') || !rows.some(row => row.type === 'agent-bridge/binding')) continue;
    const fixed = repair(rows);
    if (JSON.stringify(fixed) === JSON.stringify(rows)) continue;
    console.log((process.argv.includes('--apply') ? 'REPAIR ' : 'WOULD REPAIR ') + rows[0].id);
    if (!process.argv.includes('--apply')) continue;
    const saved = path.join(backup, relative);
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, original, { flag: 'wx' });
    // DSH reads the header frame independently; it must contain exactly one line.
    const lines = fixed.map(row => JSON.stringify(row) + '\n');
    const output = compressed ? Buffer.concat(lines.map(line => zlib.zstdCompressSync(Buffer.from(line)))) : Buffer.from(lines.join(''));
    fs.writeFileSync(file + '.repairing', output, { flag: 'wx' });
    fs.renameSync(file + '.repairing', file);
  }
  if (process.argv.includes('--apply')) console.log('Backups: ' + backup);
}
