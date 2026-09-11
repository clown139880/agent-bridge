// Run with the installed Electron executable and ELECTRON_RUN_AS_NODE=1.
// This tests the built plugin against the actual packaged DSH, without starting a Host.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const os = require('node:os');
const app = process.argv[2];
if (!app) throw new Error('Pass the absolute TokensCowork resources/app.asar path');
const base = path.join(app, 'node_modules');
const bundle = path.resolve(__dirname, '../lib/index.js');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-runtime-test-'));
const target = path.join(folder, 'host.mjs');
const source = fs.readFileSync(bundle, 'utf8').replace(/from "(@deepseek-ai\/[^"]+)"/g, (_, name) => {
  const dir = path.join(base, name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return 'from ' + JSON.stringify(pathToFileURL(path.join(dir, pkg.main)).href);
});
fs.writeFileSync(target, source);
(async () => {
  const { Session, SessionId, SESSION_FORMAT_VERSION } = await import(pathToFileURL(path.join(base, '@deepseek-ai/dsh-session/lib/index.js')));
  const plugin = await import(pathToFileURL(target));
  const rows = [
    { eventId: 'u', sessionId: 'r', turnId: 't', type: 'message.completed', timestamp: 1, payload: { role: 'user', text: 'hello' } },
    { eventId: 'a', sessionId: 'r', turnId: 't', type: 'message.completed', timestamp: 2, payload: { role: 'assistant', text: 'answer' } },
    { eventId: 'c', sessionId: 'r', turnId: 't', type: 'command.completed', timestamp: 3, payload: { command: 'pwd', output: '/repo', exitCode: 0 } },
  ];
  const session = Session.create(SessionId('contract'), plugin.projectNativeEvents(rows, []));
  const messages = session.deriveMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content[0].text, 'hello');
  assert.equal(messages[1].content[0].text, 'answer');
  assert.equal(messages[3].content[0].content[0].text, '/repo');
  assert.equal(plugin.projectNativeEvents(rows, session.snapshotEvents()).length, 0);
  const added = plugin.projectNativeEvents([{ ...rows[1], eventId: 'new' }], session.snapshotEvents());
  for (const event of added) session.append(event.type, event.data, ...(event.surfaceOp ? [{ surfaceOp: event.surfaceOp }] : []));
  assert.equal(session.deriveMessages().length, 5);
  console.log('PASS: installed DSH format ' + SESSION_FORMAT_VERSION + ', replay, tool result, incremental append and deduplication');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(folder, { recursive: true, force: true }));
