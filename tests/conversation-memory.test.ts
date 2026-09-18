import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationMemoryStore, Store } from "../packages/database/src/index.js";
import { ConversationMcpServer } from "../apps/control-plane/src/memory-mcp.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-memory-"));
  const store = new Store(join(root, "control.sqlite"));
  for (const id of ["windows", "hal"]) store.upsertMachine({ id, name: id, platform: "linux", hostname: id, capabilities: ["codex-cli"] });
  const now = Date.now() - 10_000;
  store.createSession({ id: "design-session", machineId: "windows", agentType: "codex-cli",
    projectName: "agent-bridge", projectPath: "C:\\work\\agent-bridge", matrixRoomId: "", matrixThreadId: null,
    nativeSessionId: "native-design", status: "completed", createdAt: now, updatedAt: now });
  store.createSession({ id: "other-session", machineId: "hal", agentType: "codex-cli",
    projectName: "agent-bridge", projectPath: "/root/same-name", matrixRoomId: "", matrixThreadId: null,
    nativeSessionId: "native-other", status: "completed", createdAt: now, updatedAt: now });
  const memory = new ConversationMemoryStore(store.db, join(root, "objects"));
  memory.upsertSessionProject("design-session", "git@github.com:example/agent-bridge.git");
  memory.upsertSessionProject("other-session", "https://github.com/example/unrelated.git");
  return { root, store, memory, now };
}

function message(sessionId: string, eventId: string, role: "user" | "assistant", text: string, timestamp: number) {
  return { type: "session.event" as const, eventType: "message.completed" as const, sessionId, eventId,
    timestamp, payload: { role, text } };
}

test("conversation memory deduplicates, scopes, reviews, and reads cold originals by message id", () => {
  const f = fixture();
  try {
    const original = "共享记忆设计已经确认：中心提供 MCP/CLI；项目不持有 projectId；Obsidian 不作为依赖；必须考虑存储增长和容量治理。";
    const first = f.memory.ingestEvent("windows", message("design-session", "evt-1", "user", original, f.now));
    const assistant = { ...message("design-session", "evt-2", "assistant", "建议采用中央只读检索，并保留原文指针。", f.now + 1),
      turnId: "turn-1" };
    f.memory.ingestEvent("windows", assistant);
    const terminalAlias = f.memory.ingestEvent("windows", { type: "session.event", eventType: "turn.completed",
      sessionId: "design-session", eventId: "evt-2-terminal", turnId: "turn-1", timestamp: f.now + 1,
      payload: { summary: "建议采用中央只读检索，并保留原文指针。", historyCompleteness: "terminal-only" } });
    assert.equal(terminalAlias.duplicate, true);
    assert.equal(f.memory.ingestEvent("windows", message("design-session", "evt-1", "user", original, f.now)).duplicate, true);
    f.memory.ingestEvent("hal", message("other-session", "evt-3", "user", "共享记忆设计，但这是同名目录中的无关仓库。", f.now + 2));

    const scoped = f.memory.search({ query: "共享记忆设计", machineId: "windows",
      cwd: "C:\\work\\agent-bridge" }) as { results: Array<{ sessionId: string; messageId: string }> };
    assert.deepEqual(scoped.results.map((item) => item.sessionId), ["design-session"]);
    assert.equal(scoped.results[0]!.messageId, first.messageId);

    const repository = f.memory.search({ query: "projectId", repository: "https://user:secret@github.com/example/agent-bridge.git" }) as
      { results: Array<{ sessionId: string }> };
    assert.deepEqual(repository.results.map((item) => item.sessionId), ["design-session"]);

    const review = f.memory.review("design-session") as { summary: { confirmedDecisions: Array<{ text: string; messageId: string }> } };
    assert.ok(review.summary.confirmedDecisions.some((item) => item.text.includes("Obsidian") && item.messageId === first.messageId));

    const archived = f.memory.archiveEligible(Date.now() + 1);
    assert.equal(archived.messages, 3);
    assert.ok(archived.compressedBytes > 0 && archived.hotBytes > archived.compressedBytes);
    const read = f.memory.read({ sessionId: "design-session", messageId: first.messageId, limit: 1 }) as
      { messages: Array<{ messageId: string; content: string; storage: string }> };
    assert.deepEqual(read.messages, [{ messageId: first.messageId, role: "user", content: original,
      occurredAt: f.now, sourcePosition: { sequence: 1, turnId: null, itemId: null, messageOffset: 0 }, storage: "cold",
      completeness: "complete", contentTruncated: false, originalContentChars: Array.from(original).length,
      nextMessageOffset: null }]);
    const chunk = f.store.db.prepare("SELECT relative_path FROM conversation_archive_chunks WHERE session_id='design-session' LIMIT 1")
      .get() as { relative_path: string };
    assert.ok(readFileSync(join(f.root, "objects", chunk.relative_path)).length > 0);
  } finally { f.store.db.close(); }
});

test("conversation MCP exposes the read-only search tool contract", () => {
  const f = fixture();
  f.memory.ingestEvent("windows", message("design-session", "evt-mcp", "user", "中心提供 MCP，项目不持有 projectId。", f.now));
  const mcp = new ConversationMcpServer(f.memory, "memory-secret");
  try {
    const dispatch = (mcp as unknown as { dispatch(request: unknown): unknown }).dispatch.bind(mcp);
    const listed = dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as
      { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listed.result.tools.map((tool) => tool.name),
      ["conversation_search", "conversation_review", "conversation_read"]);
    const body = dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "conversation_search", arguments: { query: "projectId", source_session_id: "native-design" } } }) as
      { result: { structuredContent: { results: Array<{ sessionId: string; messageId: string }> } } };
    assert.equal(body.result.structuredContent.results[0]!.sessionId, "design-session");
    assert.match(body.result.structuredContent.results[0]!.messageId, /^msg_/);
  } finally {
    f.store.db.close();
  }
});
