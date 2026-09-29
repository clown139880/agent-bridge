import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter, readSessionMeta, readTranscriptMessages } from '../apps/bridge/src/claude/claude-adapter.js';
import type { BridgeToControlMessage } from '../packages/protocol/src/index.js';

test('Claude turn ids survive adapter restarts and message events inherit their active turn', () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const seam = adapter as unknown as {
    startTurnEvents(session: unknown): string;
    emitSessionEvent(session: unknown, type: string, id: string, payload: Record<string, unknown>): void;
  };
  const first = {sessionId:'same-session',turnSeq:0,logs:[]};
  const second = {sessionId:'same-session',turnSeq:0,logs:[]};
  const turn = seam.startTurnEvents(first);
  assert.notEqual(seam.startTurnEvents(second), turn);
  seam.emitSessionEvent(first,'message.completed','message',{role:'assistant',text:'answer'});
  const message = events.at(-1);
  assert.ok(message?.type === 'session.event');
  assert.equal(message.turnId, turn);
});

test('Claude discovery recovers the full first user text after discovery, including block content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-history-'));
  try {
    const project = join(root, 'projects', 'fixture');
    mkdirSync(project, { recursive: true });
    const file = join(project, 'native-id.jsonl');
    const prompt = 'long prompt '.repeat(7000);
    writeFileSync(file, [
      {type:'user',cwd:root,isMeta:true,message:{content:'not a user prompt'}},
      {type:'user',cwd:root,timestamp:'2026-09-01T00:00:00Z',message:{content:[{type:'tool_result',content:'not a prompt'}]}},
      {type:'user',cwd:root,timestamp:'2026-09-01T00:00:01Z',message:{content:[{type:'text',text:prompt},{type:'text',text:'last paragraph'}]}},
    ].map(row => JSON.stringify(row)).join('\n'));
    assert.equal(readSessionMeta(file)?.firstUserText, prompt + '\nlast paragraph');
    const events: BridgeToControlMessage[] = [];
    const adapter = new ClaudeCodeAdapter({command:'',claudeHome:root,allowedRoots:[root],scanExisting:true}, event => events.push(event));
    await adapter.start();
    adapter.stop();
    assert.equal(events[0]?.type, 'session.discovered');
    const recovered = events.find(event => event.type === 'session.event');
    assert.ok(recovered && recovered.type === 'session.event');
    assert.equal(recovered.payload.text, prompt + '\nlast paragraph');
    assert.equal(recovered.eventId, 'claude:native-id:first:user');
    assert.equal(recovered.timestamp, Date.parse('2026-09-01T00:00:01Z'));
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('a Claude session created without a prompt is re-announced under its native uuid once Claude reports it', () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const seam = adapter as unknown as { emitDiscovered(session: unknown): void; handleSystem(session: unknown, message: unknown): void };
  const session: Record<string, unknown> = {sessionId:'claude-public',requestId:'claude-public',projectPath:'/work',discovered:false,turnSeq:0,logs:[]};
  seam.emitDiscovered(session);
  seam.handleSystem(session, {type:'system',subtype:'init',session_id:'native-uuid'});
  seam.handleSystem(session, {type:'system',subtype:'init',session_id:'native-uuid'});
  const announced = events.filter(event => event.type === 'session.discovered').map(event => event.type === 'session.discovered' ? event.nativeSessionId : '');
  assert.deepEqual(announced, ['claude-public', 'native-uuid']);
});

test('a Claude session whose subprocess exits is forgotten so the next turn revives it', async () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const sessions = (adapter as unknown as { sessions: Map<string, unknown> }).sessions;
  const seam = adapter as unknown as { consume(session: unknown): Promise<void> };
  const session = {sessionId:'claude-public',turnSeq:0,logs:[],tasks:new Map(),ended:false,query:(async function* () { throw new Error('Claude Code process exited with code 1'); })()};
  sessions.set('claude-public', session);
  await seam.consume(session);
  assert.equal(sessions.has('claude-public'), false);
  assert.equal(session.ended, true);
});

test('reviving a Claude session that never ran a turn starts fresh instead of resuming its public id', async () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const launches: Array<{ publicSessionId: string; resumeNativeId?: string }> = [];
  const seam = adapter as unknown as {
    launch(params: { publicSessionId: string; resumeNativeId?: string }): Promise<string>;
    emitDiscovered(session: unknown): void;
    handleSystem(session: unknown, message: unknown): void;
  };
  seam.launch = async params => { launches.push(params); return params.publicSessionId; };
  const publicId = 'claude-0b7e3f52-5a1c-4d8e-9f3a-2c6b1d4e8a90';
  const nativeId = '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';
  // Created without a prompt, then reaped while idle: the control-plane only knows the public id.
  await adapter.resumeSession(publicId, '/work', publicId);
  await adapter.resumeSession('claude-other', '/work', nativeId);
  assert.deepEqual(launches.map(launch => launch.resumeNativeId), [undefined, nativeId]);
  // The fresh process announces itself, then its init corrects the stored native id.
  const session: Record<string, unknown> = {sessionId:publicId,requestId:publicId,projectPath:'/work',discovered:false,turnSeq:0,logs:[]};
  seam.emitDiscovered(session);
  seam.handleSystem(session, {type:'system',subtype:'init',session_id:nativeId});
  const announced = events.filter(event => event.type === 'session.discovered').map(event => event.type === 'session.discovered' ? event.nativeSessionId : '');
  assert.deepEqual(announced, [publicId, nativeId]);
});

function autonomousFixture() {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({command:'',allowedRoots:[]}, event => events.push(event));
  const seam = adapter as unknown as {
    handleMessage(session: unknown, message: unknown): void;
    startTurnEvents(session: unknown): string;
  };
  const session: Record<string, unknown> = {sessionId:'claude-public',cwd:'/work',discovered:true,turnSeq:0,logs:[],
    toolUses:new Map(),tasks:new Map(),pendingApprovals:new Map()};
  const structured = () => events.flatMap(event => event.type === 'session.event' ? [event] : []);
  return { adapter, seam, session, structured };
}

test('Claude work streamed outside any turn opens an autonomous turn that its events carry', () => {
  const { seam, session, structured } = autonomousFixture();
  seam.handleMessage(session, {type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'ls'}}]}});
  const turnId = session.activeTurnId as string;
  assert.ok(turnId, 'an assistant message outside a turn opens one');
  assert.deepEqual(structured().map(event => event.eventType), ['turn.started', 'tool.started']);
  seam.handleMessage(session, {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:'a.txt'}]}});
  const command = structured().at(-1);
  assert.equal(command?.eventType, 'command.completed');
  assert.equal(command?.turnId, turnId);
  assert.equal(structured().filter(event => event.eventType === 'turn.started').length, 1, 'one autonomous turn, not one per message');
});

test('a Claude tool result outside any turn also opens an autonomous turn', () => {
  const { seam, session, structured } = autonomousFixture();
  seam.handleMessage(session, {type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'x',content:'ok'}]}});
  assert.ok(session.activeTurnId);
  assert.deepEqual(structured().map(event => event.eventType), ['turn.started', 'tool.completed']);
});

test('Claude stragglers after an interrupt do not open an autonomous turn', () => {
  const { seam, session } = autonomousFixture();
  session.lastTurnStatus = 'interrupted';
  seam.handleMessage(session, {type:'assistant',message:{content:[{type:'text',text:'late'}]}});
  assert.equal(session.activeTurnId, undefined);
});

test('an empty Claude result right after its turn starts does not close the turn; a later one does', () => {
  const { seam, session, structured } = autonomousFixture();
  const turnId = seam.startTurnEvents(session);
  seam.handleMessage(session, {type:'result',subtype:'success',is_error:false,result:''});
  assert.equal(session.activeTurnId, turnId, 'the stray empty result of a revived Claude is ignored');
  session.turnStartedAt = Date.now() - 5_000;
  seam.handleMessage(session, {type:'result',subtype:'success',is_error:false,result:''});
  assert.equal(session.activeTurnId, undefined);
  assert.equal(structured().at(-1)?.eventType, 'turn.completed');
});

test('a Claude result with a summary or an error closes the turn immediately', () => {
  const { seam, session } = autonomousFixture();
  seam.startTurnEvents(session);
  seam.handleMessage(session, {type:'result',subtype:'success',is_error:false,result:'done'});
  assert.equal(session.activeTurnId, undefined);
  seam.startTurnEvents(session);
  seam.handleMessage(session, {type:'result',subtype:'error_during_execution',is_error:true,result:''});
  assert.equal(session.activeTurnId, undefined);
});

function transcriptFixture(rows: Record<string, unknown>[]) {
  const root = mkdtempSync(join(tmpdir(), 'claude-transcript-'));
  const nativeId = '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';
  mkdirSync(join(root, 'projects', 'work'), { recursive: true });
  const file = join(root, 'projects', 'work', `${nativeId}.jsonl`);
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  return { root, nativeId, file };
}
const at = (second: number) => new Date(Date.UTC(2026, 8, 29, 12, 0, second)).toISOString();
const CLI_ROWS: Record<string, unknown>[] = [
  {type:'user',uuid:'u0',timestamp:at(0),message:{content:'relayed prompt'}},
  {type:'assistant',uuid:'a0',timestamp:at(1),message:{content:[{type:'text',text:'relayed reply'}]}},
  {type:'user',uuid:'u1',timestamp:at(10),message:{content:'cli prompt'}},
  {type:'assistant',uuid:'a1',timestamp:at(11),message:{content:[{type:'text',text:'checking'},{type:'tool_use',id:'t',name:'Bash',input:{}}]}},
  {type:'user',uuid:'r1',timestamp:at(12),message:{content:[{type:'tool_result',tool_use_id:'t',content:'ok'}]}},
  {type:'assistant',uuid:'a2',timestamp:at(13),message:{content:[{type:'text',text:'final answer'}]}},
  {type:'user',uuid:'s1',timestamp:at(14),isSidechain:true,message:{content:'subagent prompt'}},
  {type:'user',uuid:'c1',timestamp:at(15),isCompactSummary:true,isVisibleInTranscriptOnly:true,message:{content:'This session is being continued'}},
  {type:'user',uuid:'m1',timestamp:at(16),message:{content:'<command-name>/model</command-name>'}},
  {type:'user',uuid:'i1',timestamp:at(17),message:{content:[{type:'text',text:'[Request interrupted by user]'}]}},
  {type:'user',uuid:'u2',timestamp:at(18),message:{content:'second cli prompt'}},
];

test('a transcript catch-up keeps typed prompts and the final reply to each', () => {
  const { root, file } = transcriptFixture(CLI_ROWS);
  try {
    const messages = readTranscriptMessages(file, Date.parse(at(5)));
    assert.deepEqual(messages.map(m => [m.uuid, m.role, m.text]), [
      ['u1', 'user', 'cli prompt'], ['a2', 'assistant', 'final answer'], ['u2', 'user', 'second cli prompt']]);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('reviving a Claude session relays what the transcript gained after the last stored event', async () => {
  const { root, nativeId } = transcriptFixture(CLI_ROWS);
  try {
    const events: BridgeToControlMessage[] = [];
    const adapter = new ClaudeCodeAdapter({command:'',claudeHome:root,allowedRoots:[]}, event => events.push(event));
    const sessions = (adapter as unknown as { sessions: Map<string, unknown> }).sessions;
    (adapter as unknown as { launch(params: { publicSessionId: string; resumeNativeId?: string }): Promise<string> }).launch = async params => {
      sessions.set(params.publicSessionId, {sessionId:params.publicSessionId,nativeSessionId:params.resumeNativeId,turnSeq:0,logs:[]});
      return params.publicSessionId;
    };
    await adapter.resumeSession('claude-public', '/work', nativeId, undefined, Date.parse(at(5)));
    const relayed = events.flatMap(event => event.type === 'session.event' ? [event] : []);
    assert.deepEqual(relayed.map(event => [event.eventId, event.payload.role, event.timestamp]), [
      [`claude:${nativeId}:transcript:u1`, 'user', Date.parse(at(10))],
      [`claude:${nativeId}:transcript:a2`, 'assistant', Date.parse(at(13))],
      [`claude:${nativeId}:transcript:u2`, 'user', Date.parse(at(18))]]);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('a held idle Claude session continued in a CLI is relaunched and caught up before the next turn', async () => {
  const { root, nativeId, file } = transcriptFixture(CLI_ROWS.slice(0, 2));
  try {
    const events: BridgeToControlMessage[] = [];
    const adapter = new ClaudeCodeAdapter({command:'',claudeHome:root,allowedRoots:[]}, event => events.push(event));
    const sessions = (adapter as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
    const launches: string[] = [];
    const seam = adapter as unknown as {
      launch(params: { publicSessionId: string; resumeNativeId?: string }): Promise<string>;
      reloadIfContinuedElsewhere(session: unknown): Promise<Record<string, unknown>>;
    };
    seam.launch = async params => {
      launches.push(String(params.resumeNativeId));
      sessions.set(params.publicSessionId, {sessionId:params.publicSessionId,nativeSessionId:params.resumeNativeId,turnSeq:0,logs:[],pendingApprovals:new Map()});
      return params.publicSessionId;
    };
    const held = {sessionId:'claude-public',nativeSessionId:nativeId,projectPath:'/work',settledAt:Date.parse(at(2)),turnSeq:0,logs:[],
      pendingApprovals:new Map(),input:{end() {}},abort:new AbortController(),ended:false};
    sessions.set('claude-public', held);
    // Only the subprocess's own writes: nothing to reload.
    assert.equal(await seam.reloadIfContinuedElsewhere(held), held);
    writeFileSync(file, CLI_ROWS.map(row => JSON.stringify(row)).join('\n'));
    const relaunched = await seam.reloadIfContinuedElsewhere(held);
    assert.notEqual(relaunched, held);
    assert.equal(held.ended, true);
    assert.deepEqual(launches, [nativeId]);
    assert.deepEqual(events.flatMap(event => event.type === 'session.event' ? [event.eventId] : []),
      ['u1', 'a2', 'u2'].map(uuid => `claude:${nativeId}:transcript:${uuid}`));
  } finally { rmSync(root, {recursive:true,force:true}); }
});
