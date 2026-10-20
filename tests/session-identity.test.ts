import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

type ControlInternals = {
  bridges: Map<string, { machineId: string; name: string; capabilities: string[]; socket: WebSocket }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
};

test('Claude transcript discovery and first prompt preserve the public Bridge session identity', async () => {
  const item = fixture();
  try {
    const discovered = { type:'session.discovered' as const, sessionId:'claude-public',nativeSessionId:'native-uuid',agentType:'claude-code' as const,projectPath:'/work/agent-bridge',projectName:'agent-bridge',status:'waiting' as const,createdAt:Date.now() };
    await item.internals.handleBridgeMessage('dev',discovered);
    await item.internals.handleBridgeMessage('dev',{...discovered,sessionId:'native-uuid'});
    const recovered = {type:'session.event' as const,sessionId:'native-uuid',eventType:'message.completed' as const,eventId:'claude:native-uuid:first:user',timestamp:Date.now(),payload:{role:'user',text:'original prompt',recoveredFirstPrompt:true}};
    await item.internals.handleBridgeMessage('dev',recovered);
    await item.internals.handleBridgeMessage('dev',recovered);
    assert.equal(item.store.getSession('native-uuid'),undefined);
    const rows = item.store.db.prepare('SELECT session_id, event_id FROM events WHERE event_id=?').all('claude:claude-public:first:user');
    assert.equal(rows.length,1);
    assert.equal(rows[0]?.session_id,'claude-public');
  } finally { item.dispose(); }
});

test('a re-announced Claude session corrects its native id instead of forking a second session', async () => {
  const item = fixture();
  try {
    const discovered = { type:'session.discovered' as const, sessionId:'claude-public',nativeSessionId:'claude-public',agentType:'claude-code' as const,projectPath:'/work/agent-bridge',projectName:'agent-bridge',status:'waiting' as const,createdAt:Date.now() };
    await item.internals.handleBridgeMessage('dev',discovered);
    await item.internals.handleBridgeMessage('dev',{...discovered,nativeSessionId:'native-uuid',status:'working' as const});
    assert.equal(item.store.getSession('claude-public')?.nativeSessionId,'native-uuid');
    assert.equal((item.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {n:number}).n,1);
  } finally { item.dispose(); }
});

test('an inventory that falls back to the public id keeps the native id already on record', async () => {
  const item = fixture();
  try {
    const discovered = { type:'session.discovered' as const, sessionId:'claude-public',nativeSessionId:'native-uuid',agentType:'claude-code' as const,projectPath:'/work/agent-bridge',projectName:'agent-bridge',status:'waiting' as const,createdAt:Date.now() };
    await item.internals.handleBridgeMessage('dev',discovered);
    await item.internals.handleBridgeMessage('dev',{ type:'state.snapshot', complete:false, approvals:[], userInputs:[], sessions:[{ sessionId:'claude-public',nativeSessionId:'claude-public',agentType:'claude-code',projectPath:'/work/agent-bridge',projectName:'agent-bridge',activityStatus:'idle',createdAt:Date.now(),updatedAt:Date.now(),source:'app-server',historyCompleteness:'loaded-only' }] } as unknown as BridgeToControlMessage);
    assert.equal(item.store.getSession('claude-public')?.nativeSessionId,'native-uuid');
  } finally { item.dispose(); }
});

function fixture(): {
  control: ControlPlane;
  internals: ControlInternals;
  store: Store;
  sent: ControlToBridgeMessage[];
  dispose(): void;
} {
  const databasePath = join(tmpdir(), `agent-bridge-launch-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const sent: ControlToBridgeMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); },
  } as WebSocket;
  store.upsertMachine({ id: "dev", name: "Workstation", platform: "linux", hostname: "dev.local", capabilities: ["codex-cli"] });
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0 });
  const internals = control as unknown as ControlInternals;
  internals.bridges.set("dev", { machineId: "dev", name: "Workstation", capabilities: ["codex-cli"], socket });
  return {
    control, internals, store, sent,
    dispose() {
      store.db.close();
      rmSync(databasePath, { force: true });
    },
  };
}
