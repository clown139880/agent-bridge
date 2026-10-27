// Validate the wire events with the installed 0.2.1 runtime, without starting a Host.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { loadChatProjection } = require('./chat-projection.cjs');
async function run(runtime) {
  const target = path.resolve(__dirname, '../.verify-remote-host.mjs');
  const source = fs.readFileSync(path.resolve(__dirname, '../lib/index.js'), 'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g, (_, name) => {
    const folder = path.join(runtime, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    return 'from ' + JSON.stringify(pathToFileURL(path.join(folder, pkg.main)).href);
  });
  fs.writeFileSync(target, source);
  try {
    const { AgentControlService } = await import(pathToFileURL(target));
    const native = await import(pathToFileURL(path.join(runtime, '@deepseek-ai/dsh-session/lib/index.js')));
    const service = new AgentControlService({ bridge: { mode: 'mock', origin: 'http://fixture.invalid', tokenEnv: '', timeoutMs: 1000 } });
    let rows = [
      { eventId: 'u', sessionId: 'r', turnId: 't', timestamp: 1, type: 'message.completed', payload: { role: 'user', text: 'question' } },
      { eventId: 'a', sessionId: 'r', turnId: 't', timestamp: 2, type: 'message.completed', payload: { role: 'assistant', text: 'answer' } },
      { eventId: 'tool', sessionId: 'r', turnId: 't', timestamp: 3, type: 'command.completed', payload: { command: 'pwd', output: '/repo', status: 'completed' } },
    ];
    service.bridge.call = async ({ args }) => ({ data: rows.slice(Number(args.after || 0)), nextCursor: String(rows.length), hasMore: false });
    service.importTarget = { catalog: () => ({ sessions: [{ sessionId: 'r', nativeId: 'agent-bridge-old', title: 'Remote', workspace: '/repo' }] }) };
    const catalog = await service.dispatch({ domain: 'bridge', operation: 'virtual_catalog' });
    const id = catalog.sessions[0].nativeId;
    native.SessionId(id);
    const opened = await service.dispatch({ domain: 'bridge', operation: 'virtual_open', args: { id } });
    const events = opened.snapshot.records.map(row => row.event);
    native.Session.create(native.SessionId(id), events);
    const project = loadChatProjection(path.join(runtime, '@deepseek-ai/dsh-client-ui-chat/lib/client.js'));
    assert.ok(project(events).length > 0);
    const prefix = JSON.stringify(events);
    rows.push({ eventId: 'b', sessionId: 'r', turnId: 't', timestamp: 4, type: 'message.completed', payload: { role: 'assistant', text: 'live update' } });
    const delta = await service.dispatch({ domain: 'bridge', operation: 'virtual_poll', args: { id, epoch: opened.epoch, after: opened.snapshot.cursor } });
    const all = [...events, ...delta.records.map(row => row.event)];
    native.Session.create(native.SessionId(id), all);
    assert.equal(JSON.stringify(all.slice(0, events.length)), prefix);
    assert.equal(all.filter(row => row.type === 'turn/start').length, 1);
    assert.equal(all.filter(row => row.type === 'turn/end').length, 0);
    console.log(JSON.stringify({ result: 'PASS', runtime: '0.2.1-rc.2', initialEvents: events.length, appendedEvents: delta.records.length, chatMessages: project(all).length }));
  } finally { fs.unlinkSync(target); }
}
run(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
