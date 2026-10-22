import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMemory } from "../packages/agent-memory/src/index.js";
import { ConversationMemoryStore, Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import { ConversationMcpServer } from "../apps/control-plane/src/memory-mcp.js";
import { reviewContext, runMemoryTool, type AgentMemoryMcpOptions } from "../apps/control-plane/src/mcp/memory.js";
import { MemoryReviews, parseVerdict, type Reviewer } from "../apps/control-plane/src/memory-review.js";

function vault(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-review-"));
  const root = join(dir, "agent-memory");
  mkdirSync(join(root, "scopes"), { recursive: true });
  writeFileSync(join(root, "predicates.yaml"), "predicates:\n  - id: rule\n");
  for (const [id, body] of [["_global", "所有 agent 都该知道的事。"], ["repo-demo", "演示项目。"]]) {
    mkdirSync(join(root, "scopes", id!));
    writeFileSync(join(root, "scopes", id!, "scope.md"), `---\ntype: scope\nid: ${id}\ntitle: ${id}\nstatus: active\ndiscoverable: true\n`
      + "bindings:\n  matrix_rooms: []\n  repositories: []\n  locations: []\nbootstrap_budget: 1500\n---\n" + `${body}\n`);
    writeFileSync(join(root, "scopes", id!, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  }
  return dir;
}

const WRITERS = [{ name: "hermes", role: "agent" as const, token: "hermes-token-0123456789" },
  { name: "codex@wsl", role: "project" as const, token: "codex-token-0123456789" }];

function fixture(reviewer?: Reviewer) {
  const memory = new AgentMemory({ vault: vault() });
  const store = new Store(join(mkdtempSync(join(tmpdir(), "memory-review-db-")), "control.sqlite"));
  const history = new ConversationMemoryStore(store.db);
  const events: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const options: AgentMemoryMcpOptions = { store: memory, writers: WRITERS };
  const reviews = options.review = new MemoryReviews(store.db, {
    apply: (tool, args, writer) => runMemoryTool(history, options, tool, args, writer),
    context: (tool, args) => reviewContext(options, tool, args),
    reviewer: reviewer && ((prompt) => { prompts.push(prompt); return reviewer(prompt); }),
    notify: (event) => events.push(event),
  });
  const mcp = new ConversationMcpServer(history, options);
  const call = async (token: string, name: string, args: Record<string, unknown>) => {
    const target = mcp as unknown as { authenticate(header: string): unknown; dispatch(raw: unknown, principal: unknown): Promise<any> };
    return target.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      target.authenticate(`Bearer ${token}`));
  };
  return { memory, store, reviews, events, prompts, call };
}

const RULE = { scope: "_global", topic: "deploy-window", kind: "rule", value: "周五不部署" };

test("a project agent's _global write is held, reviewed and applied as that agent", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(async () => { await released; return { decision: "allow", reason: "适合全局" }; });
  try {
    const held = (await f.call("codex-token-0123456789", "write", RULE)).result.structuredContent;
    assert.equal(held.review.status, "reviewing");
    assert.match(held.review.summary, /_global · deploy-window\/rule = 周五不部署/);
    assert.equal(f.memory.get("_global", "deploy-window", "rule").length, 0, "nothing is written before the review");
    release();
    await f.reviews.idle();
    assert.match(f.prompts[0]!, /所有 agent 都该知道的事/, "the reviewer sees what the target scope is for");
    assert.equal(f.memory.get("_global", "deploy-window", "rule")[0]!.by, "codex@wsl");
    const outcome = (await f.call("codex-token-0123456789", "review", { review_id: held.review.id })).result.structuredContent;
    assert.deepEqual([outcome.status, outcome.decidedBy, outcome.reason], ["applied", "reviewer", "适合全局"]);
    assert.deepEqual(f.events.map((event) => event.status), ["applied"]);

    const own = (await f.call("codex-token-0123456789", "write", { ...RULE, scope: "repo-demo" })).result.structuredContent;
    assert.equal(own.path, "scopes/repo-demo/facts/deploy-window/rule.md", "its own scope is written directly");
    const agent = (await f.call("hermes-token-0123456789", "write", { ...RULE, value: "周五也可以" })).result.structuredContent;
    assert.ok(agent.commit !== undefined && !agent.review, "an assistant still writes _global directly");
  } finally { f.store.db.close(); }
});

test("a denied write is dropped, and a failed review waits for the human", async () => {
  const denying = fixture(async () => ({ decision: "deny", reason: "是项目细节，写到项目作用域" }));
  try {
    const held = (await denying.call("codex-token-0123456789", "write", RULE)).result.structuredContent;
    await denying.reviews.idle();
    assert.equal(denying.reviews.get(held.review.id)!.status, "denied");
    assert.equal(denying.memory.get("_global", "deploy-window", "rule").length, 0);
  } finally { denying.store.db.close(); }

  const broken = fixture(async () => { throw new Error("model unavailable"); });
  try {
    const held = (await broken.call("codex-token-0123456789", "write", RULE)).result.structuredContent;
    await broken.reviews.idle();
    const waiting = broken.reviews.get(held.review.id)!;
    assert.equal(waiting.status, "waiting_human");
    assert.match(waiting.reason!, /model unavailable/);
    assert.deepEqual(broken.events.map((event) => event.status), ["waiting_human"]);
  } finally { broken.store.db.close(); }
});

test("the reviewer's verdict must be a clear JSON decision", () => {
  assert.deepEqual(parseVerdict('好的。\n{"decision":"deny","reason":"重复"}'), { decision: "deny", reason: "重复" });
  assert.throws(() => parseVerdict('{"decision":"maybe"}'), /no verdict/);
  assert.throws(() => parseVerdict("allow"), /no verdict/);
});

test("only the human decides a review over /api/v1, and it applies once", async () => {
  const dir = vault();
  const path = join(tmpdir(), `memory-review-${randomUUID()}.sqlite`), store = new Store(path);
  const control = new ControlPlane(store, { host: "127.0.0.1", port: 0, controlApiWriteToken: "human-write",
    agents: WRITERS, agentMemory: { vault: dir }, memoryReview: {} });
  await control.start();
  try {
    const address = (control as unknown as { http: HttpServer }).http.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const rpc = await fetch(`${base}/mcp/memory`, { method: "POST", headers: { authorization: "Bearer codex-token-0123456789",
      "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: RULE } }) });
    const frame = (await rpc.text()).split("\n").find((line) => line.startsWith("data: "))!;
    const review = JSON.parse(frame.slice(6)).result.structuredContent.review;
    assert.equal(review.status, "waiting_human", "without a reviewer the human decides");

    const decide = (token: string) => fetch(`${base}/api/v1/memory-reviews/${review.id}/decision`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ choice: "allow" }) });
    assert.equal((await decide("codex-token-0123456789")).status, 403, "an agent cannot decide");
    const decided = await decide("human-write");
    assert.equal(decided.status, 200);
    assert.deepEqual([(await decided.json() as any).status], ["applied"]);
    assert.equal((await decide("human-write")).status, 409);
    const listed = await fetch(`${base}/api/v1/memory-reviews?status=applied`, { headers: { authorization: "Bearer codex-token-0123456789" } });
    assert.deepEqual((await listed.json() as any).data.map((row: any) => row.id), [review.id]);
    assert.equal(new AgentMemory({ vault: dir }).get("_global", "deploy-window", "rule")[0]!.by, "codex@wsl");
  } finally { await control.stop(); store.db.close(); rmSync(path, { force: true }); }
});
