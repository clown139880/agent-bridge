import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocket } from "ws";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import type { MatrixGateway } from "../apps/control-plane/src/matrix.js";
import type { BridgeToControlMessage, ControlToBridgeMessage } from "../packages/protocol/src/index.js";

class FakeMatrix {
  notices: Array<{ id: string; body: string; metadata?: Record<string, unknown> }> = [];
  roots: Array<{ id: string; body: string; metadata?: Record<string, unknown> }> = [];
  threads: Array<{ rootId: string; body: string; metadata?: Record<string, unknown> }> = [];
  reactions: Array<{ id: string; targetId: string; key: string }> = [];
  private nextId = 0;

  async sendNotice(body: string, metadata?: Record<string, unknown>): Promise<string> {
    const id = this.id("notice");
    this.notices.push({ id, body, metadata });
    return id;
  }

  async sendRoot(body: string, metadata?: Record<string, unknown>): Promise<string> {
    const id = this.id("root");
    this.roots.push({ id, body, metadata });
    return id;
  }

  async sendThread(rootId: string, body: string, metadata?: Record<string, unknown>): Promise<string> {
    this.threads.push({ rootId, body, metadata });
    return this.id("thread");
  }

  async sendReaction(targetId: string, key: string): Promise<string> {
    const id = this.id("reaction");
    this.reactions.push({ id, targetId, key });
    return id;
  }

  async removeReaction(): Promise<void> {}
  stop(): void {}

  private id(kind: string): string {
    this.nextId += 1;
    return `$${kind}-${this.nextId}`;
  }
}

type ControlInternals = {
  roomId: string;
  bridges: Map<string, { machineId: string; name: string; capabilities: string[]; socket: WebSocket }>;
  handleBridgeMessage(machineId: string, message: BridgeToControlMessage): Promise<void>;
};

function fixture(): {
  control: ControlPlane;
  internals: ControlInternals;
  matrix: FakeMatrix;
  store: Store;
  sent: ControlToBridgeMessage[];
  dispose(): void;
} {
  const databasePath = join(tmpdir(), `agent-bridge-launch-${randomUUID()}.sqlite`);
  const store = new Store(databasePath);
  const matrix = new FakeMatrix();
  const sent: ControlToBridgeMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) { sent.push(JSON.parse(value) as ControlToBridgeMessage); },
  } as WebSocket;
  store.upsertMachine({ id: "dev", name: "Workstation", platform: "linux", hostname: "dev.local", capabilities: ["codex-cli"] });
  const control = new ControlPlane(store, matrix as unknown as MatrixGateway, { host: "127.0.0.1", port: 0 });
  const internals = control as unknown as ControlInternals;
  internals.roomId = "!control:test";
  internals.bridges.set("dev", { machineId: "dev", name: "Workstation", capabilities: ["codex-cli"], socket });
  return {
    control, internals, matrix, store, sent,
    dispose() {
      store.db.close();
      rmSync(databasePath, { force: true });
    },
  };
}

test("a plain room prompt launches in the selected path and becomes the session thread root", async () => {
  const item = fixture();
  try {
    await item.control.onRoomMessage("Fix the flaky tests", "@me:test", "$prompt");
    assert.match(item.matrix.notices.at(-1)?.body ?? "", /发送绝对路径/);

    await item.control.onRoomMessage("z:agent-bridge", "@me:test", "$path");
    const start = item.sent.at(-1);
    assert.equal(start?.type, "start_agent");
    assert.equal(start && "projectPath" in start ? start.projectPath : undefined, "z:agent-bridge");
    assert.equal(start && "prompt" in start ? start.prompt : undefined, "Fix the flaky tests");
    const requestId = start && "sessionId" in start ? start.sessionId : "";

    await item.internals.handleBridgeMessage("dev", {
      type: "session.discovered",
      requestId,
      sessionId: "native-thread-id",
      nativeSessionId: "native-thread-id",
      agentType: "codex-cli",
      projectPath: "/work/agent-bridge",
      projectName: "agent-bridge",
      status: "working",
      createdAt: Date.now(),
    });

    assert.equal(item.store.getSession("native-thread-id")?.matrixThreadId, "$prompt");
    assert.equal(item.matrix.roots.length, 0);
    assert.equal(item.matrix.threads.at(-1)?.rootId, "$prompt");
    assert.doesNotMatch(item.matrix.threads.at(-1)?.body ?? "", /native-thread-id/);
    assert.equal(item.matrix.threads.at(-1)?.metadata?.session_id, "native-thread-id");
  } finally {
    item.dispose();
  }
});

test("recent workspaces are offered as reactions and only the prompt author can choose", async () => {
  const item = fixture();
  try {
    const now = Date.now();
    item.store.createSession({
      id: "previous", machineId: "dev", agentType: "codex-cli", projectName: "agent-bridge",
      projectPath: "/work/agent-bridge", matrixRoomId: "!control:test", matrixThreadId: "$old",
      nativeSessionId: "previous-native", status: "completed", createdAt: now, updatedAt: now,
    });

    await item.control.onRoomMessage("Add a health check", "@me:test", "$prompt");
    const choice = item.matrix.notices.at(-1);
    assert.match(choice?.body ?? "", /1️⃣ \/work\/agent-bridge/);
    assert.match(choice?.body ?? "", /➕ 新的工作目录/);

    await item.control.onReaction(choice!.id, "1️⃣", "@someone-else:test");
    assert.equal(item.sent.length, 0);
    await item.control.onReaction(choice!.id, "1️⃣", "@me:test");
    assert.equal(item.sent.at(-1)?.type, "start_agent");
    assert.equal(item.sent.at(-1) && "projectPath" in item.sent.at(-1)! ? item.sent.at(-1)!.projectPath : undefined, "/work/agent-bridge");
  } finally {
    item.dispose();
  }
});

test("passive sessions stay silent until a title exists, then publish a compact root", async () => {
  const item = fixture();
  const discovered = {
    type: "session.discovered" as const,
    sessionId: "desktop-thread-id",
    nativeSessionId: "desktop-thread-id",
    agentType: "codex-desktop" as const,
    projectPath: "/work/agent-bridge",
    projectName: "agent-bridge",
    status: "completed" as const,
    createdAt: Date.now(),
  };
  try {
    await item.internals.handleBridgeMessage("dev", discovered);
    assert.equal(item.matrix.roots.length, 0);
    assert.equal(item.store.getSession("desktop-thread-id")?.matrixThreadId, null);

    await item.internals.handleBridgeMessage("dev", { ...discovered, title: "Repair CI" });
    assert.equal(item.matrix.roots.length, 1);
    assert.match(item.matrix.roots[0]!.body, /Repair CI/);
    assert.doesNotMatch(item.matrix.roots[0]!.body, /desktop-thread-id|\/work\/agent-bridge/);
    assert.equal(item.matrix.roots[0]!.metadata?.native_session_id, "desktop-thread-id");
  } finally {
    item.dispose();
  }
});
