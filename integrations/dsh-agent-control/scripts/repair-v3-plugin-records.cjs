// Offline, narrowly scoped envelope repair. Run with Desktop stopped and the
// active Desktop's node_modules directory as --runtime. Default is a dry run.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { decodeFile, encodeRows } = require('./migrate-v2-history.cjs');
const types = new Set(['agent-bridge/binding', 'agent-bridge/event']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function repair(rows, repairStaleStep = false) {
  const [header, ...events] = rows;
  if (header?.type !== 'session' || header.version !== 3 || !header.id?.startsWith('agent-bridge-')) throw new Error('Expected a Bridge V3 session');
  if (!events.some(event => event.type === 'agent-bridge/binding')) throw new Error('Missing Bridge binding');
  const output = [header, ...events.map((event, seq) => {
    if (event.seq !== seq) throw new Error('Non-dense event sequence');
    if (!types.has(event.type)) return event;
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data) || event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) throw new Error('Unexpected Bridge record envelope');
    if (event.type === 'agent-bridge/event' && typeof event.data.eventId !== 'string') throw new Error('Missing acknowledgement identity');
    return { ...event, ignorable: true };
  })];
  return repairStaleStep ? repairStaleFinalStep(output) : output;
}

// Old live projection advanced the open step without updating the native loop's
// cached coordinate. Only repair an unambiguous final answer + closing pair in
// an otherwise empty open step; no insertion, renumbering or payload loss.
function repairStaleFinalStep(rows) {
  const output = rows.slice();
  let turn, step, empty = false;
  const closed = new Set();
  for (let i = 1; i < output.length; i++) {
    const event = output[i], data = event.data;
    if (event.type === 'turn/start') { turn = data.turn; step = undefined; closed.clear(); }
    else if (event.type === 'step/start') { step = data.step; empty = true; }
    else if (event.type === 'step/end') { closed.add(data.step); step = undefined; }
    else if (event.type === 'turn/end') { turn = undefined; step = undefined; }
    else if (event.type === 'assistant/message' && data.step !== step) {
      const end = output[i + 1], finish = output[i + 2];
      if (!empty || !Number.isSafeInteger(step) || data.turn !== turn || !closed.has(data.step)
        || data.step >= step || data.message?.source?.provider !== 'agent-bridge'
        || data.message?.source?.kind !== 'model' || data.message?.content?.some(block => block.type !== 'text')
        || end?.type !== 'step/end' || end.data.turn !== turn || end.data.step !== data.step
        || finish?.type !== 'turn/end' || finish.data.turn !== turn) throw new Error('Ambiguous stale assistant step; refusing repair');
      output[i] = { ...event, data: { ...data, step } };
      output[i + 1] = { ...end, data: { ...end.data, step } };
      empty = false;
    } else if (!types.has(event.type)) empty = false;
  }
  return output;
}

async function run(args = process.argv.slice(2)) {
  if (args.includes('--apply') && process.platform === 'win32') {
    const running = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'TokensCowork.exe' -or ($_.Name -eq 'electron.exe' -and $_.ExecutablePath -like '*dsh-plugin-desktop*') }).Count"], { encoding: 'utf8', windowsHide: true }).trim();
    if (running !== '0') throw new Error('Stop TokensCowork and its Host before applying repairs');
  }
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--runtime')) throw new Error('Supply --runtime <active Desktop node_modules>');
  const runtime = path.resolve(value('--runtime'));
  const { createSessionFormatCatalogWithChildren } = await import(pathToFileURL(path.join(runtime, '@deepseek-ai/dsh-session-format-catalog/lib/index.js')));
  const root = path.resolve(args.includes('--sessions') ? value('--sessions') : path.join(os.homedir(), '.dsh/sessions'));
  const backupRoot = path.join(os.homedir(), '.dsh/backups/bridge-v3-records', new Date().toISOString().replace(/[:.]/g, '-'));
  const files = fs.readdirSync(root, { recursive: true }).filter(file => /session\.v3\.jsonl(?:\.zstd)?$/.test(file));
  const report = [];
  for (const relative of files) {
    const file = path.join(root, relative);
    const rows = decodeFile(file);
    if (!rows[0]?.id?.startsWith('agent-bridge-') || !rows.some(event => types.has(event.type) && event.ignorable !== true)) continue;
    if (['session.v4.jsonl', 'session.v4.jsonl.zstd'].some(name => fs.existsSync(path.join(path.dirname(file), name)))) continue;
    const original = fs.readFileSync(file);
    try {
      const output = repair(rows, args.includes('--repair-stale-step'));
      // This operation changes no coordinates or payloads. The native reader
      // still owns generation migration and child catalog discovery.
      const restore = createSessionFormatCatalogWithChildren([]).createRestore(output[0], { recovery: 'strict', validation: 'current' });
      for (const event of output.slice(1)) restore.decodeRow(event);
      const restored = restore.finish();
      const entry = { file, id: rows[0].id, sha256: hash(original), events: output.length - 1, targetVersion: restored.header.version, status: 'validated' };
      if (args.includes('--apply')) {
        const backup = path.join(backupRoot, relative);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.writeFileSync(backup, original, { flag: 'wx' });
        assert.equal(hash(fs.readFileSync(backup)), entry.sha256);
        const temp = file + '.migrating';
        try {
          fs.writeFileSync(temp, encodeRows(output, file.endsWith('.zstd')), { flag: 'wx' });
          // Decode through the same compressed reader before publication.
          assert.deepEqual(decodeFile(temp), output);
          assert.equal(hash(fs.readFileSync(file)), entry.sha256, 'Source changed during repair');
          fs.renameSync(temp, file);
        } catch (error) {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
          throw error;
        }
        entry.status = 'repaired';
        entry.backup = backup;
      }
      report.push(entry);
    } catch (error) { report.push({ file, status: 'refused', reason: String(error) }); }
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}
module.exports = { repair, repairStaleFinalStep, run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
