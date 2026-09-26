import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter, readSessionMeta } from '../apps/bridge/src/claude/claude-adapter.js';
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
  const session = {sessionId:'claude-public',turnSeq:0,logs:[],ended:false,query:(async function* () { throw new Error('Claude Code process exited with code 1'); })()};
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
