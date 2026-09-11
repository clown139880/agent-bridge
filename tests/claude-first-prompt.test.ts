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
