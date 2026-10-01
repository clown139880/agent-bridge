import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '../apps/bridge/src/claude/sdk/query.js';
import { PushableAsyncIterable } from '../apps/bridge/src/claude/sdk/pushable.js';

test('a Claude process that exits non-zero reports its stderr, not only the exit code', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-stderr-'));
  try {
    const executable = join(dir, 'claude');
    writeFileSync(executable, "#!/bin/sh\necho \"--resume claude-x is not a UUID and does not match any session title\" >&2\nexit 1\n");
    chmodSync(executable, 0o755);
    const input = new PushableAsyncIterable<never>();
    const stream = query({ prompt: input, options: { cwd: dir, pathToClaudeCodeExecutable: executable, resume: 'claude-x' } });
    await assert.rejects((async () => { for await (const _ of stream) { /* drain */ } })(),
      /exited with code 1: --resume claude-x is not a UUID/);
    input.end();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
