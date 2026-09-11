import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServerAdapter, codexInput } from '../apps/bridge/src/app-server.js';
const ref = { id: 'image-test', filename: 'test.png', mimeType: 'image/png', size: 3 };
const fetchAttachment = async () => ({ ref, mediaType: 'image/png', base64: 'YWJj' });
test('Codex rejects missing or unsupported image storage instead of silently dropping attachments', async () => {
  await assert.rejects(codexInput('look', [ref]), /unavailable/);
  await assert.rejects(codexInput('look', [{ ...ref, mimeType: 'text/plain' }], fetchAttachment), /Unsupported/);
  await assert.rejects(codexInput('look', [ref], async () => { throw new Error('fetch failed'); }), /fetch failed/);
});
test('Codex sends image input for creation, continuation and steering, including image-only turns', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const adapter = new CodexAppServerAdapter({ command: 'codex', url: 'ws://unused', allowedRoots: [process.cwd()], manageServer: false, reconnectMs: 3000, fetchAttachment }, () => {});
  const internals = adapter as unknown as { readyPromise: Promise<void>; socket: { readyState: number }; activeTurns: Map<string, string>; request(method: string, params: Record<string, unknown>): Promise<unknown> };
  internals.readyPromise = Promise.resolve(); internals.socket = { readyState: 1 };
  internals.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: 'images', cwd: process.cwd(), status: { type: 'idle' } }, turn: { id: 'turn-images' } }; };
  await adapter.startSession('create', process.cwd(), '', undefined, undefined, [ref]);
  assert.deepEqual(calls.find(call => call.method === 'turn/start')?.params.input, [{ type: 'image', url: 'data:image/png;base64,YWJj' }]);
  internals.activeTurns.clear(); calls.length = 0;
  await adapter.submitTurnAction('continue', 'images', 'describe', 'start_turn', undefined, undefined, undefined, [ref]);
  assert.deepEqual(calls.find(call => call.method === 'turn/start')?.params.input, [{ type: 'text', text: 'describe', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,YWJj' }]);
  calls.length = 0;
  await adapter.submitTurnAction('steer', 'images', '', 'steer', 'turn-images', undefined, undefined, [ref]);
  assert.deepEqual(calls.find(call => call.method === 'turn/steer')?.params.input, [{ type: 'image', url: 'data:image/png;base64,YWJj' }]);
});
