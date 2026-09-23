import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeRegistry } from '../apps/control-plane/src/bridge-registry.js';
import type { ModelCatalogRequestMessage } from '../packages/protocol/src/index.js';

function registryWithBridge(sent: ModelCatalogRequestMessage[]): BridgeRegistry {
  const registry = new BridgeRegistry();
  const socket = { readyState: 1, send: (raw: string) => { sent.push(JSON.parse(raw) as ModelCatalogRequestMessage); } };
  registry.set({ machineId: 'hal', name: 'HAL', capabilities: [], socket } as never);
  return registry;
}

test('the worker agent type reaches the bridge so co-located backends do not share one catalog', async () => {
  const sent: ModelCatalogRequestMessage[] = [];
  const registry = registryWithBridge(sent);

  const claude = registry.requestModels('hal', 'claude-code');
  const codex = registry.requestModels('hal', 'codex-cli');
  const unspecified = registry.requestModels('hal');

  assert.deepEqual(sent.map(message => message.agentType), ['claude-code', 'codex-cli', undefined]);
  // Distinct request ids keep the three in-flight catalogs apart.
  assert.equal(new Set(sent.map(message => message.requestId)).size, 3);

  for (const [index, pending] of [claude, codex, unspecified].entries()) {
    assert.equal(registry.resolveModels('hal', sent[index]!.requestId, { models: [{ id: `model-${index}` }] }), true);
    assert.deepEqual(await pending, { models: [{ id: `model-${index}` }] });
  }
});

test('a model catalog response is not accepted from another machine', async () => {
  const sent: ModelCatalogRequestMessage[] = [];
  const registry = registryWithBridge(sent);
  const pending = registry.requestModels('hal', 'pi');
  assert.equal(registry.resolveModels('dev-wsl', sent[0]!.requestId, { models: [] }), false);
  assert.equal(registry.resolveModels('hal', sent[0]!.requestId, { models: [] }), true);
  await pending;
});
