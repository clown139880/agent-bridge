import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../apps/bridge/src/claude/claude-adapter.js';
import { fetchClaudeRelayModels, resolveClaudeRelay } from '../apps/bridge/src/claude/model-catalog.js';
import type { BridgeToControlMessage } from '../packages/protocol/src/index.js';

const RELAY_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'] as const;

function claudeHome(env: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-model-'));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ env }));
  return root;
}

/** The developer running these tests very likely has a relay configured; hide it. */
async function withoutRelayEnv<T>(body: () => Promise<T>): Promise<T> {
  const saved = RELAY_KEYS.map(key => [key, process.env[key]] as const);
  for (const key of RELAY_KEYS) delete process.env[key];
  try { return await body(); } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('the relay is resolved from settings.json when the environment does not carry it', async () => {
  const root = claudeHome({ ANTHROPIC_BASE_URL: 'https://relay.example/', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'claude-opus-5' });
  try {
    await withoutRelayEnv(async () => {
      const relay = await resolveClaudeRelay(root);
      // The trailing slash would double up against the /v1/models path.
      assert.equal(relay?.baseUrl, 'https://relay.example');
      assert.equal(relay?.token, 'secret');
      assert.equal(relay?.defaultModel, 'claude-opus-5');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the process environment wins over settings.json, and no base URL means no relay', async () => {
  const root = claudeHome({ ANTHROPIC_BASE_URL: 'https://settings.example' });
  const bare = claudeHome({ ANTHROPIC_AUTH_TOKEN: 'secret' });
  try {
    await withoutRelayEnv(async () => {
      process.env['ANTHROPIC_BASE_URL'] = 'https://env.example';
      assert.equal((await resolveClaudeRelay(root))?.baseUrl, 'https://env.example');
      delete process.env['ANTHROPIC_BASE_URL'];
      assert.equal(await resolveClaudeRelay(bare), undefined);
      assert.equal(await resolveClaudeRelay(join(bare, 'missing')), undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('both the Anthropic and OpenAI-compatible model list shapes are accepted', async () => {
  const original = globalThis.fetch;
  const rows = [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    { id: 'deepseek-v4' },
    { id: 'deepseek-v4' },
    { id: '' },
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as typeof fetch;
  try {
    const models = await fetchClaudeRelayModels({ baseUrl: 'https://relay.example', defaultModel: 'deepseek-v4' });
    assert.deepEqual(models.map(model => model.id), ['claude-opus-5', 'deepseek-v4']);
    assert.equal(models[0]?.displayName, 'Claude Opus 5');
    // No display_name: the id stands in rather than an empty label.
    assert.equal(models[1]?.displayName, 'deepseek-v4');
    assert.equal(models[0]?.isDefault, undefined);
    assert.equal(models[1]?.isDefault, true);
  } finally { globalThis.fetch = original; }
});

test('an unreachable relay is not cached as an empty catalog', async () => {
  const root = claudeHome({ ANTHROPIC_BASE_URL: 'https://relay.example' });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response('', { status: 502, statusText: 'Bad Gateway' });
    return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await withoutRelayEnv(async () => {
      const adapter = new ClaudeCodeAdapter({ command: '', claudeHome: root, allowedRoots: [root], scanExisting: false }, () => {});
      await assert.rejects(adapter.models(), /502/);
      assert.deepEqual((await adapter.models()).map(model => model.id), ['claude-opus-5']);
      // The second success is cached; a third call must not reach the relay again.
      await adapter.models();
      assert.equal(calls, 2);
    });
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed model is pushed to Claude before the turn and an unchanged one is not', async () => {
  const events: BridgeToControlMessage[] = [];
  const adapter = new ClaudeCodeAdapter({ command: '', allowedRoots: [] }, event => events.push(event));
  const applied: string[] = [];
  const session = { sessionId: 'session', model: 'claude-opus-5', query: { setModel: async (model: string) => { applied.push(model); } } };
  const seam = adapter as unknown as { applyModel(session: unknown, model?: string): Promise<void> };

  await seam.applyModel(session, 'claude-opus-5');
  await seam.applyModel(session, '  ');
  await seam.applyModel(session, undefined);
  assert.deepEqual(applied, []);

  await seam.applyModel(session, 'deepseek-v4');
  assert.deepEqual(applied, ['deepseek-v4']);
  assert.equal(session.model, 'deepseek-v4');
  // Repeating the now-current model is a no-op.
  await seam.applyModel(session, 'deepseek-v4');
  assert.deepEqual(applied, ['deepseek-v4']);
});

test('a model switch on a session that is not running fails the turn', async () => {
  const adapter = new ClaudeCodeAdapter({ command: '', allowedRoots: [] }, () => {});
  const seam = adapter as unknown as { applyModel(session: unknown, model?: string): Promise<void> };
  await assert.rejects(seam.applyModel({ sessionId: 'session' }, 'deepseek-v4'), /not running/);
});
