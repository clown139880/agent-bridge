// Verify the built plugin against the active Desktop dependencies, not dev deps.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { repair } = require('./repair-v3-plugin-records.cjs');
async function run(runtime) {
  const target = path.resolve(__dirname, '../.verify-v4-host.mjs');
  const installed = name => pathToFileURL(path.join(runtime, '@deepseek-ai', name, 'lib/index.js')).href;
  const source = fs.readFileSync(path.resolve(__dirname, '../lib/index.js'), 'utf8').replace(/from "(@deepseek-ai\/[^"]+)"/g, (_, name) => {
    const folder = path.join(runtime, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    return 'from ' + JSON.stringify(pathToFileURL(path.join(folder, pkg.main)).href);
  });
  fs.writeFileSync(target, source);
  try {
    const plugin = await import(pathToFileURL(target));
    const { Session, SessionId } = await import(installed('dsh-session'));
    const { createSessionFormatCatalogWithChildren } = await import(installed('dsh-session-format-catalog'));
    const old = [
      { type: 'session', version: 3, id: 'agent-bridge-test', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      { type: 'agent-bridge/binding', seq: 0, time: 1, data: { sessionId: 'remote', origin: 'http://fixture.invalid' } },
      { type: 'agent-bridge/event', seq: 1, time: 1, data: { eventId: 'already-seen', turnId: 'turn' } },
    ];
    const restore = rows => {
      const reader = createSessionFormatCatalogWithChildren([]).createRestore(rows[0], { recovery: 'strict', validation: 'current' });
      rows.slice(1).forEach(row => reader.decodeRow(row));
      return reader.finish();
    };
    assert.throws(() => restore(old), /unknown event type/);
    const repaired = repair(old);
    assert.deepEqual(repair(repaired), repaired);
    assert.equal(old[1].ignorable, undefined);
    const restored = restore(repaired);
    assert.equal(restored.events[0].type, 'plugin:agent-bridge/binding');
    const remote = id => ({ eventId: id, turnId: 'turn', timestamp: 2, type: 'message.completed', payload: { role: 'assistant', text: 'answer' } });
    assert.deepEqual(plugin.projectNativeEvents([remote('already-seen')], restored.events), []);
    const events = plugin.projectNativeEvents([remote('new')], restored.events, 'remote', 'tool-role');
    assert.ok(events.some(event => event.type === 'plugin:agent-bridge/event' && event.ignorable === true));
    const session = Session.create(SessionId('v4-projection'), [...restored.events, ...events]);
    assert.equal(session.deriveMessages().at(-1).content[0].text, 'answer');
    // Exercise the actual target's incremental record writer and binding reader.
    const agent = { id: session.id, session, status: 'idle' };
    const importTarget = new plugin.AgentBridgeImportTarget({ agents: { get: () => agent } }, {}, 'http://fixture.invalid');
    assert.equal(importTarget.binding(session.id).sessionId, 'remote');
    importTarget.acknowledge(session.id, [{ eventId: 'incremental', turnId: 'turn' }]);
    importTarget.acknowledge(session.id, [{ eventId: 'incremental', turnId: 'turn' }]);
    assert.equal(session.snapshotEvents().filter(event => event.data.eventId === 'incremental').length, 1);
    assert.equal(session.snapshotEvents().at(-1).ignorable, true);
    console.log('PASS: actual V4 migration, retained metadata, replay, binding lookup, incremental plugin records and deduplication');
  } finally { fs.unlinkSync(target); }
}
if (require.main === module) run(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
