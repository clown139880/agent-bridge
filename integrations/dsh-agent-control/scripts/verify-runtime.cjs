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
let stage = 'session replay';
const deadline = setTimeout(() => { console.error('FAIL: runtime verification timed out at ' + stage); process.exit(1); }, 30000);
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
  const installed = async name => {
    const dir = path.join(base, '@deepseek-ai', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return import(pathToFileURL(path.join(dir, pkg.main)).href);
  };
  const { Context } = await installed('cordis');
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(folder).href + '/';
  const mount = async (name, config) => {
    stage = 'mount ' + name;
    const mod = await installed(name);
    await ctx.plugin(mod.default ?? mod, config);
  };
  try {
    await mount('cordis-plugin-loader');
    ctx.loader.builtins.include = (await installed('cordis-plugin-include')).default;
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent']) await mount(name);
    await mount('dsh-session-persistence-jsonl', { root: path.join(folder, 'sessions'), compression: 'none' });
    await mount('dsh-agent-loop', { agents: [] });
    await mount('dsh-agent-presets', { default: 'agent-bridge', roots: [{path: path.join(folder, 'presets'), trust: 'user'}], includeShippedRoot: false, includeUserRoot: false });
    await mount('dsh-storage');
    await mount('dsh-storage-json', {root: path.join(folder, 'storage')});
    await mount('dsh-storage-domain', {backend: 'json'});
    await mount('dsh-workspace');
    await mount('dsh-attachment-local', {dshHome: path.join(folder,'attachment-home')});
    const remote = {sessionId:'r', workerId:'w', workspace:'/remote/project', title:'Bridge runtime fixture', status:'idle', updatedAt:3};
    const bridge = {call: async ({operation}) => {
      if (operation === 'workers') return {workers:[{id:'w', hostname:'remote.example', name:'Remote fixture'}]};
      if (operation === 'sessions') return {data:[remote],hasMore:false};
      if (operation === 'session_events') return {data:rows,hasMore:false};
      throw new Error('Unexpected Bridge operation: '+operation);
    }};
    let target = new plugin.AgentBridgeImportTarget(ctx, bridge, 'http://runtime-fixture.invalid', path.join(folder,'bridge'));
    try {
      stage = 'ensure preset';
      await target.ensurePreset();
      stage = 'synchronize native sessions';
      await target.refresh();
      assert.equal(target.status().error, '');
      assert.equal(target.status().nativeSessions, 1);
      const agent = ctx.agents.list()[0];
      assert.equal(agent.session.deriveMessages().length, 4);
      assert.equal(agent.session.header.agentPreset, 'agent-bridge');
      assert.ok(await ctx.sessionPersistence.stat(agent.id));
      const workspace = await ctx.workspaceRegistry.resolveByPath(agent.session.header.cwd);
      assert.ok(workspace, 'Bridge session must join the actual workspace registry');
      const id = agent.id;
      await target.dispose();
      target = new plugin.AgentBridgeImportTarget(ctx, bridge, 'http://runtime-fixture.invalid', path.join(folder,'bridge'));
      const resumed = await target.ensure(remote);
      assert.equal(resumed.id, id);
      assert.equal(resumed.session.deriveMessages().length, 4);
      console.log('PASS: installed DSH Agent creation, preset mounting, JSONL persistence, workspace registry and resume');
      stage = 'native provider turn';
      let submitted = false;
      const receiptRows = [
        {eventId:'reply-user',sessionId:'r',turnId:'reply',type:'message.completed',timestamp:4,payload:{role:'user',text:'runtime probe'}},
        {eventId:'reply-assistant',sessionId:'r',turnId:'reply',type:'message.completed',timestamp:5,payload:{role:'assistant',text:'remote response'}},
        {eventId:'reply-end',sessionId:'r',turnId:'reply',type:'turn.completed',timestamp:6,payload:{status:'completed'}},
      ];
      let uploadedImage;
      let submittedAttachments;
      bridge.call = async ({operation,args}) => {
        if (operation === 'upload') { uploadedImage = args; return {id:'fixture-image',filename:'probe.png',mimeType:'image/png',size:Buffer.from(args.content,'base64').length}; }
        if (operation === 'session_events') return {data:submitted ? [...rows,...receiptRows] : rows,hasMore:false};
        if (operation === 'session') return remote;
        if (operation === 'submit_turn') { submitted = true; submittedAttachments = args.attachments; return {status:'succeeded',actionId:'fixture-action',turnId:'reply'}; }
        if (operation === 'approvals' || operation === 'user_input') return {data:[],hasMore:false};
        throw new Error('Unexpected Bridge operation: '+operation);
      };
      const adapter = new plugin.AgentBridgeLlmAdapter({bridge}, target, 1);
      ctx.llm.registerAdapter(['agent-bridge'], adapter);
      const {createUserMessage} = await installed('dsh-llm');
      const sharpModule = require(path.join(base,'sharp'));
      const sharp = sharpModule.default ?? sharpModule;
      const imageBytes = await sharp({create:{width:16,height:16,channels:3,background:'#0080ff'}}).png().toBuffer();
      const imageRef = await ctx.attachments.saveImage({data:imageBytes,mediaType:'image/png',name:'probe.png'});
      resumed.followup(createUserMessage({content:[{type:'text',text:'runtime probe'},{type:'image',attachment:imageRef}],source:{kind:'user'}}));
      await resumed.whenIdle();
      assert.equal(submitted,true);
      assert.equal(uploadedImage.mimeType,'image/png');
      assert.ok(Buffer.from(uploadedImage.content,'base64').length > 0);
      assert.equal(submittedAttachments[0].id,'fixture-image');
      assert.ok(resumed.session.deriveMessages().some(message => message.content.some(block => block.text === 'remote response')));
      adapter.commitAcks(resumed.id);
      await target.syncHistory(resumed.id);
      assert.equal(resumed.session.deriveMessages().filter(message => message.content.some(block => block.text === 'remote response')).length,1);
      console.log('PASS: installed native image storage -> Bridge upload -> turn attachment -> native response, followed by deduplicated reconciliation');
    } finally { await target.dispose(); }
  } finally { await ctx.fiber.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { clearTimeout(deadline); await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
