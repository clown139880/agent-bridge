import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMemory, MemoryError, parseDocument, type Writer } from "../packages/agent-memory/src/index.js";

const hermes: Writer = { name: "hermes", role: "agent" };
const codex: Writer = { name: "codex@wsl", role: "project" };

function scopeFile(id: string, title: string, bindings: string, extra = ""): string {
  return `---\ntype: scope\nid: ${id}\ntitle: ${title}\nstatus: active\ndiscoverable: ${extra.includes("hidden") ? "false" : "true"}\n`
    + `bindings:\n${bindings}\nbootstrap_budget: ${id === "_global" ? 3600 : 1500}\n---\n${id === "_global" ? "关于你本人。" : ""}\n`;
}

function fixture(options: { git?: boolean } = {}) {
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-"));
  const root = join(vault, "agent-memory");
  mkdirSync(join(root, "scopes"), { recursive: true });
  writeFileSync(join(root, "predicates.yaml"), "predicates:\n  - id: preference\n  - id: rule\n  - id: fact\n  - id: decision\n  - id: profile\n");
  const scopes: Array<[string, string, string, string?]> = [
    ["_global", "全局", "  matrix_rooms: [\"!dm:example.org\", \"!akasha:example.org\"]\n  repositories: []\n  locations: []"],
    ["travel", "旅游助手", "  matrix_rooms: [\"!travel:example.org\"]\n  repositories: []\n  locations: []"],
    ["hui-radio", "惠的电台", "  matrix_rooms: [\"!radio:example.org\"]\n  repositories: []\n  locations:\n    - {machine: hal, path: /root/projects/hui-radio-v2}"],
    ["agent-bridge", "Agent Bridge", "  matrix_rooms: []\n  repositories: [\"git@github.com:Example/agent-bridge.git\"]\n  locations: []"],
    ["card-negumi", "惠（夜）", "  matrix_rooms: []\n  repositories: []\n  locations: []", "hidden"],
  ];
  for (const [id, title, bindings, extra] of scopes) {
    mkdirSync(join(root, "scopes", id));
    writeFileSync(join(root, "scopes", id, "scope.md"), scopeFile(id, title, bindings, extra));
    writeFileSync(join(root, "scopes", id, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  }
  if (options.git) {
    execFileSync("git", ["init", "-q"], { cwd: vault });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: vault });
    execFileSync("git", ["add", "-A"], { cwd: vault });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "skeleton"], { cwd: vault });
  }
  let clock = new Date("2026-10-12T08:00:00Z");
  const memory = new AgentMemory({ vault, lockPath: options.git ? join(vault, ".lock") : undefined, cacheDir: join(vault, "cache"),
    now: () => clock });
  return { vault, root, memory, tick: (iso: string) => { clock = new Date(iso); } };
}

test("scopes resolve by room (ignoring threads), repository, location, hint, then _global", () => {
  const { memory } = fixture();
  assert.equal(memory.resolveScope({ roomId: "!travel:example.org" }).scope, "travel");
  assert.equal(memory.resolveScope({ roomId: "!akasha:example.org:$thread-1" }).scope, "_global");
  const repo = memory.resolveScope({ repository: "https://github.com/example/agent-bridge" });
  assert.deepEqual([repo.scope, repo.matched], ["agent-bridge", "repository"]);
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2/" }).scope, "hui-radio");
  assert.equal(memory.resolveScope({ machineId: "gqx", cwd: "/root/projects/hui-radio-v2" }).scope, "_global");
  assert.equal(memory.resolveScope({ scopeHint: "travel" }).scope, "travel");
  assert.deepEqual(memory.resolveScope({}).matched, "global");
});

test("unbound rooms and repositories get provisional scopes only when a writer asks", () => {
  const { memory, root } = fixture();
  assert.equal(memory.resolveScope({ roomId: "!new:example.org", roomName: "新房间" }).scope, "_global");
  const room = memory.resolveScope({ roomId: "!new:example.org", roomName: "新房间" }, { writer: hermes });
  assert.ok(room.created && room.scope.startsWith("room-"));
  assert.equal(memory.scope(room.scope).title, "新房间");
  assert.equal(memory.resolveScope({ roomId: "!new:example.org" }).scope, room.scope);
  const repo = memory.resolveScope({ repository: "git@gitea.local:me/Thing.git" }, { writer: codex });
  assert.equal(repo.scope, "repo-thing");
  assert.equal(parseDocument(readFileSync(join(root, "scopes/repo-thing/scope.md"), "utf8")).data.status, "provisional");
});

test("a key bound by two scopes is reported as a conflict, not guessed", () => {
  const { memory, root } = fixture();
  writeFileSync(join(root, "scopes/agent-bridge/scope.md"),
    scopeFile("agent-bridge", "AB", "  matrix_rooms: [\"!travel:example.org\"]\n  repositories: []\n  locations: []"));
  const result = memory.resolveScope({ roomId: "!travel:example.org" });
  assert.equal(result.scope, "_global");
  assert.deepEqual(result.conflict, ["agent-bridge", "travel"]);
  assert.ok(memory.lint().some((line) => line.startsWith("binding conflict: room matrix:!travel:example.org")));
});

test("a parsed scope is reused until its scope.md changes, and callers cannot alter the kept copy", () => {
  const { memory, root } = fixture();
  const first = memory.scope("travel");
  first.rooms.push("matrix:!mutated:example.org");
  assert.deepEqual(memory.scope("travel").rooms, ["matrix:!travel:example.org"]);
  writeFileSync(join(root, "scopes/travel/scope.md"),
    scopeFile("travel", "旅行", "  matrix_rooms: [\"!trip:example.org\"]\n  repositories: []\n  locations: []"));
  assert.equal(memory.scope("travel").title, "旅行");
  assert.equal(memory.resolveScope({ roomId: "!trip:example.org" }).scope, "travel");
  assert.equal(memory.roomScope("!trip:example.org:$thread-1")?.id, "travel");
  assert.equal(memory.roomScope("!travel:example.org"), undefined);
});

test("writes declare topics, supersede with history, answer as-of queries and tombstone retractions", () => {
  const { memory, root, tick } = fixture();
  memory.write(hermes, { scope: "_global", topic: "reply-style", topicDisplay: "回复风格", aliases: ["说话方式"],
    kind: "preference", value: "大白话，多用比喻" });
  tick("2026-10-20T08:00:00Z");
  const updated = memory.write(hermes, { scope: "_global", topic: "reply-style", kind: "preference", value: "简洁，必要时用比喻" });
  assert.equal(updated.path, "scopes/_global/facts/reply-style/preference.md");
  const current = parseDocument(readFileSync(join(root, updated.path), "utf8")).data;
  assert.equal(current.supersedes, "facts/reply-style/preference/2026-10-12.md");
  assert.equal(memory.get("_global", "reply-style", "preference")[0]!.value, "简洁，必要时用比喻");
  assert.equal(memory.get("_global", "reply-style", "preference", { asOf: "2026-10-15" })[0]!.value, "大白话，多用比喻");
  assert.equal(memory.get("_global", "reply-style", "preference", { history: true }).length, 2);
  assert.equal(memory.search("说话方式", ["_global"])[0]!.score, 3);

  memory.retract(hermes, { scope: "_global", topic: "reply-style", kind: "preference", reason: "不再适用" });
  assert.equal(memory.get("_global", "reply-style", "preference").length, 0);
  assert.equal(memory.search("比喻", ["_global"]).length, 0);
  assert.ok(memory.get("_global", "reply-style", "preference", { history: true }).some((fact) => fact.retracted));
  memory.write(hermes, { scope: "_global", topic: "reply-style", kind: "preference", value: "重新设定" });
  assert.equal(memory.get("_global", "reply-style", "preference")[0]!.value, "重新设定");
});

test("new facts are not pinned unless asked; an update keeps the slot's pin unless it says otherwise", () => {
  const { memory } = fixture();
  const pinned = () => memory.get("travel", "visa", "rule")[0]!.pinned;
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "出境先查签证" });
  assert.equal(pinned(), false);
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "出境先查签证", pin: true });
  assert.equal(pinned(), true);
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "出境先查签证和护照有效期" });
  assert.equal(pinned(), true);
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "出境先查签证和护照有效期", pin: false });
  assert.equal(pinned(), false);
  // A retracted slot starts over: its old pin does not come back.
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "v", pin: true });
  memory.retract(hermes, { scope: "travel", topic: "visa", kind: "rule", reason: "重写" });
  memory.write(hermes, { scope: "travel", topic: "visa", kind: "rule", value: "重新设定" });
  assert.equal(pinned(), false);
});

test("writes are validated: kinds, slugs, one-line values, secrets, aliases and project writers on _global", () => {
  const { memory } = fixture();
  const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (error) { return (error as MemoryError).code; } };
  assert.equal(code(() => memory.write(hermes, { scope: "travel", topic: "x", kind: "made-up", value: "v" })), "unknown_kind");
  assert.equal(code(() => memory.write(hermes, { scope: "travel", topic: "高原", kind: "fact", value: "v" })), "invalid_topic");
  assert.equal(code(() => memory.write(hermes, { scope: "travel", topic: "x", kind: "fact", value: "a\nb" })), "invalid_value");
  assert.equal(code(() => memory.write(hermes, { scope: "travel", topic: "x", kind: "fact", value: "key",
    body: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" })), "secret_rejected");
  assert.equal(code(() => memory.write(codex, { scope: "_global", topic: "x", kind: "fact", value: "v" })), "forbidden");
  assert.equal(code(() => memory.write(codex, { scope: "agent-bridge", topic: "deploy", kind: "rule", value: "只用 deploy.sh" })), "ok");
  memory.write(hermes, { scope: "travel", topic: "altitude", aliases: ["高原"], kind: "fact", value: "孩子高原反应敏感" });
  assert.equal(code(() => memory.write(hermes, { scope: "travel", topic: "oxygen", aliases: ["高原"], kind: "fact", value: "v" })), "alias_conflict");
  assert.equal(code(() => memory.write(hermes, { scope: "nope", topic: "x", kind: "fact", value: "v" })), "unknown_scope");
});

test("bootstrap is deterministic, budgeted by whole items and scoped; search hides undiscoverable scopes", () => {
  const { memory, vault, tick } = fixture();
  memory.write(hermes, { scope: "_global", topic: "simon", kind: "profile", value: "住杭州，一家三口", pin: true });
  memory.write(hermes, { scope: "travel", topic: "altitude", kind: "fact", value: "孩子在 3600m 血氧掉到 87%", pin: true });
  memory.write(hermes, { scope: "travel", topic: "draft", kind: "fact", value: "未置顶的事实" });
  memory.write(hermes, { scope: "travel", topic: "plan", kind: "decision", value: "定稿方案A+，10/3 出发", pin: true });
  memory.write(hermes, { scope: "card-negumi", topic: "nickname", kind: "preference", value: "叫老公", pin: true });
  tick("2026-10-12T09:00:00Z");

  const first = memory.sessionBootstrap("travel");
  assert.equal(first, memory.sessionBootstrap("travel"));
  // Content only: description, then one line per pinned fact.
  assert.equal(first, "关于你本人。\n- 住杭州，一家三口\n- 孩子在 3600m 血氧掉到 87%\n- 定稿方案A+，10/3 出发");
  assert.doesNotMatch(first, /未置顶的事实|叫老公/);
  assert.equal(readFileSync(join(vault, "cache/travel.md"), "utf8"), `${first}\n`);

  // Budget counts whole lines; the description must fit.
  assert.equal(memory.bootstrap("_global", 12), "关于你本人。");
  assert.throws(() => memory.bootstrap("_global", 3), /budget_too_small/);

  assert.deepEqual(memory.search("老公", "all"), []);
  assert.equal(memory.search("老公", ["card-negumi"]).length, 1);
  assert.deepEqual(memory.search("方案A+", "all").map((hit) => [hit.scope, hit.path]), [["travel", "scopes/travel/facts/plan/decision.md"]]);
  // Not every term has to match; the hit matching more terms ranks first.
  const loose = memory.search("旅行安排 血氧 方案A+", ["travel"]);
  assert.deepEqual(loose.map((hit) => hit.path), ["scopes/travel/facts/altitude/fact.md", "scopes/travel/facts/plan/decision.md"]);
  assert.deepEqual(memory.search("完全不相关", ["travel"]), []);
  // Unsegmented Chinese sentences: alias inside the message, or shared fragments.
  assert.equal(memory.recall("下次带孩子去西藏要注意血氧吗", ["travel"])[0]!.path, "scopes/travel/facts/altitude/fact.md");
  assert.deepEqual(memory.recall("今天天气不错", ["travel"]), []);
  assert.equal(memory.search("记得孩子血氧的事么", ["travel"])[0]!.path, "scopes/travel/facts/altitude/fact.md");
  assert.equal(memory.resolveScope({ roomId: "!travel:example.org" }).prefetch, false);
  assert.ok(memory.bootstrap("card-negumi").includes("叫老公"));

  // Persona scopes: soul.md is human-edited, returned by load() ahead of the learned memory.
  writeFileSync(join(vault, "agent-memory/scopes/card-negumi/soul.md"), "# 人设\n\n温柔。\n");
  assert.equal(memory.load("card-negumi"), "# 人设\n\n温柔。\n\n- 叫老公");
  assert.equal(memory.load("card-negumi", { persona: false }), "- 叫老公");
  assert.equal(memory.persona("travel"), "");
});

test("each write is one commit touching only its scope; broken hand edits are skipped and linted", () => {
  const { memory, vault, root } = fixture({ git: true });
  writeFileSync(join(vault, "unrelated-note.md"), "human note\n");
  const result = memory.write(hermes, { scope: "travel", topic: "visa", kind: "fact", value: "不需要签证" });
  assert.match(result.commit ?? "", /^[0-9a-f]{40}$/);
  const files = execFileSync("git", ["show", "--name-only", "--format=%an|%s", "HEAD"], { cwd: vault, encoding: "utf8" }).trim().split("\n");
  assert.equal(files[0], "agent-memory (hermes)|memory(travel): add visa/fact");
  assert.deepEqual(files.slice(1).filter(Boolean).sort(), ["agent-memory/scopes/travel/entities.md", "agent-memory/scopes/travel/facts/visa/fact.md"]);
  assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: vault, encoding: "utf8" }), /\?\? unrelated-note\.md/);

  writeFileSync(join(root, "scopes/travel/facts/visa/broken.md"), "no frontmatter");
  writeFileSync(join(root, "scopes/travel/facts/visa/fact.sync-conflict-20261012-100000-ABCDEFG.md"), "x");
  assert.equal(memory.get("travel", "visa", "fact")[0]!.value, "不需要签证");
  const problems = memory.lint();
  assert.ok(problems.some((line) => line.includes("broken.md: missing_frontmatter")));
  assert.ok(problems.some((line) => line.includes("sync conflict copy")));
  assert.ok(memory.resolveScope({ roomId: "!travel:example.org" }).warnings[0]!.startsWith("sync_conflict:"));
  assert.ok(existsSync(join(root, "scopes/travel/facts/visa/fact.md")));
});

test("MCP gives every agent token reads and writes, and keeps project agents out of _-scopes", async () => {
  const { memory } = fixture();
  const { createServer } = await import("node:http");
  const { ConversationMcpServer } = await import("../apps/control-plane/src/memory-mcp.js");
  const { ConversationMemoryStore, Store } = await import("../packages/database/src/index.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-memory-db-")), "control.sqlite"));
  const mcp = new ConversationMcpServer(new ConversationMemoryStore(store.db), {
    store: memory, writers: [{ name: "hermes", role: "agent", token: "hermes-token-0123456789" },
      { name: "codex@wsl", role: "project", token: "codex-token-0123456789" }] });
  const server = createServer((request, response) => { void mcp.handle(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let id = 0;
  const rpc = async (token: string, method: string, params?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return { status: response.status, body: await response.json() as any };
  };
  const call = async (token: string, name: string, args: Record<string, unknown>) =>
    (await rpc(token, "tools/call", { name, arguments: args })).body;
  try {
    assert.equal((await rpc("wrong-token-0123456789", "tools/list")).status, 401);
    const names = async (token: string) => (await rpc(token, "tools/list")).body.result.tools.map((tool: { name: string }) => tool.name);
    const readerTools = await names("codex-token-0123456789");
    assert.ok(readerTools.includes("conversation_search") && readerTools.includes("memory_bootstrap"));
    assert.ok((await names("hermes-token-0123456789")).includes("memory_write"));

    const written = await call("hermes-token-0123456789", "memory_write",
      { scope: "travel", topic: "visa", topic_display: "签证", kind: "fact", value: "免签", pin: true });
    assert.equal(written.result.structuredContent.path, "scopes/travel/facts/visa/fact.md");
    assert.equal(memory.get("travel", "visa", "fact")[0]!.by, "hermes");
    assert.match((await call("codex-token-0123456789", "memory_write",
      { scope: "_global", topic: "x", kind: "fact", value: "v" })).error.message, /forbidden/);

    const resolved = await call("codex-token-0123456789", "memory_resolve_scope", { room_id: "!travel:example.org" });
    assert.equal(resolved.result.structuredContent.scope, "travel");
    const boot = await call("codex-token-0123456789", "memory_bootstrap", { scope: "travel" });
    assert.match(boot.result.structuredContent.text, /^- 免签$/m);
    const hits = await call("codex-token-0123456789", "memory_search", { query: "免签" });
    assert.equal(hits.result.structuredContent.hits[0].scope, "travel");
    const scopes = await call("codex-token-0123456789", "memory_scopes", {});
    assert.equal(scopes.result.structuredContent.hidden, 1);
    assert.equal((await call("codex-token-0123456789", "bootstrap", { scope: "travel" })).result.structuredContent.scope, "travel",
      "the legacy endpoint also accepts 0.7 names");
    assert.equal(mcp.legacyCalls, 7);
  } finally {
    server.close();
    store.db.close();
  }
});

test("/mcp/memory serves the short tool names over the MCP SDK with the same token boundary", async () => {
  const { memory } = fixture();
  const { Hono } = await import("../apps/control-plane/node_modules/hono/dist/index.js");
  const { mcpRoute } = await import("../apps/control-plane/src/mcp/route.js");
  const { memoryEndpoint } = await import("../apps/control-plane/src/mcp/memory.js");
  const { ConversationMemoryStore, Store } = await import("../packages/database/src/index.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-memory-db-")), "control.sqlite"));
  const app = new Hono().all("/mcp/memory", mcpRoute(memoryEndpoint(new ConversationMemoryStore(store.db), {
    store: memory, writers: [{ name: "hermes", role: "agent", token: "hermes-token-0123456789" },
      { name: "codex@wsl", role: "project", token: "codex-token-0123456789" }] })));
  let id = 0;
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const response = await app.request("/mcp/memory", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return { status: response.status, body: (text && JSON.parse(data ? data.slice(6) : text)) as any };
  };
  try {
    assert.equal((await rpc("wrong-token-0123456789", "tools/list")).status, 401);
    const init = await rpc("codex-token-0123456789", "initialize", { protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "test", version: "0" } });
    assert.equal(init.body.result.serverInfo.name, "agent-bridge-memory");
    const names = async (token: string) => (await rpc(token, "tools/list")).body.result.tools.map((tool: { name: string }) => tool.name);
    const readerTools = await names("codex-token-0123456789");
    assert.ok(readerTools.includes("history_search") && readerTools.includes("bootstrap") && readerTools.includes("scope"));
    assert.ok(readerTools.includes("write") && !readerTools.some((name: string) => name.startsWith("memory_")));
    assert.ok((await names("hermes-token-0123456789")).includes("write"));

    const denied = await rpc("codex-token-0123456789", "tools/call", { name: "write", arguments: { scope: "_global", topic: "visa", kind: "fact", value: "v" } });
    assert.ok(denied.body.error || denied.body.result?.isError, "a project agent cannot write _global without review");
    const written = await rpc("hermes-token-0123456789", "tools/call", { name: "write",
      arguments: { scope: "travel", topic: "visa", topic_display: "签证", kind: "fact", value: "免签", pin: true } });
    assert.equal(written.body.result.structuredContent.path, "scopes/travel/facts/visa/fact.md");
    const boot = await rpc("codex-token-0123456789", "tools/call", { name: "bootstrap", arguments: { scope: "travel" } });
    assert.match(boot.body.result.structuredContent.text, /^- 免签$/m);
    const failed = await rpc("codex-token-0123456789", "tools/call", { name: "get", arguments: { scope: "travel", topic: "visa" } });
    assert.ok(failed.body.error || failed.body.result?.isError, "schema validation rejects a missing kind");
  } finally {
    store.db.close();
  }
});

test("a new scope takes the id the caller asked for, and a rename carries its memory and bindings", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentMemory } = await import("../packages/agent-memory/src/index.js");
  const vault = mkdtempSync(join(tmpdir(), "rename-")), root = join(vault, "agent-memory", "scopes");
  mkdirSync(join(root, "_global"), { recursive: true });
  writeFileSync(join(root, "_global", "scope.md"), "---\ntype: scope\nid: _global\ntitle: g\nstatus: active\ndiscoverable: true\nbindings:\n  rooms: []\n  repositories: []\n  locations: []\nbootstrap_budget: 1500\n---\n");
  writeFileSync(join(root, "_global", "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  writeFileSync(join(vault, "agent-memory", "predicates.yaml"), "predicates:\n  - id: rule\n");
  const memory = new AgentMemory({ vault });
  const writer = { name: "claude@hal", role: "agent" as const };
  try {
    const named = memory.resolveScope({ roomId: "!ops:x", roomName: "全局运维", scopeHint: "ops" }, { writer });
    assert.equal(named.scope, "ops"); assert.equal(memory.scope("ops").title, "全局运维");
    const generated = memory.resolveScope({ roomId: "!b:x", roomName: "B" }, { writer });
    assert.match(generated.scope, /^room-[0-9a-f]{8}$/);
    memory.write(writer, { scope: generated.scope, topic: "role", kind: "rule", value: "测试规则" });
    const renamed = memory.renameScope(writer, generated.scope, "bee", "蜜蜂");
    assert.equal(renamed.id, "bee"); assert.equal(renamed.title, "蜜蜂");
    assert.deepEqual(renamed.rooms, ["matrix:!b:x"]);
    assert.equal(memory.resolveScope({ roomId: "!b:x" }).scope, "bee");
    assert.ok(existsSync(join(root, "bee", "facts", "role", "rule.md")) && !existsSync(join(root, generated.scope)));
    assert.throws(() => memory.renameScope(writer, "bee", "ops"), /scope_exists/);
    assert.throws(() => memory.renameScope(writer, "_global", "x"), /forbidden/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test("a repository identity with a port resolves its scope however often it is normalized", () => {
  const { memory, root } = fixture();
  mkdirSync(join(root, "scopes", "radio"));
  writeFileSync(join(root, "scopes", "radio", "scope.md"), scopeFile("radio", "电台",
    "  matrix_rooms: []\n  repositories: [\"https://gitea.example.org:8443/me/Radio.git\"]\n  locations: []"));
  // The Bridge sends `host:8443/me/radio`; the scp reading once turned the port into a path segment.
  for (const remote of ["gitea.example.org:8443/me/radio", "https://gitea.example.org:8443/me/radio.git", "ssh://git@gitea.example.org:8443/me/radio"])
    assert.equal(memory.resolveScope({ repository: remote }).scope, "radio", remote);
  assert.equal(memory.resolveScope({ repository: "git@gitea.example.org:me/radio.git" }).scope, "_global", "scp syntax has no port");
});

test("a location binding covers its subdirectories and worktrees; the longest binding wins", () => {
  const { memory, root } = fixture();
  mkdirSync(join(root, "scopes", "radio-agent"));
  writeFileSync(join(root, "scopes", "radio-agent", "scope.md"), scopeFile("radio-agent", "电台 agent",
    "  matrix_rooms: []\n  repositories: []\n  locations:\n    - {machine: hal, path: /root/projects/hui-radio-v2/agent}\n    - {machine: win, path: 'C:/Work/Radio'}"));
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2/.claude/worktrees/x" }).scope, "hui-radio");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2/agent/audience" }).scope, "radio-agent");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2-old" }).scope, "_global", "a sibling with the same prefix is not inside");
  assert.equal(memory.resolveScope({ machineId: "win", cwd: "c:\\work\\radio\\src" }).scope, "radio-agent", "Windows paths ignore case");
});

test("the work index resolves repository then location, never a room or hint, and is rebuilt when a scope changes", () => {
  const { memory, root } = fixture();
  const index = memory.workIndex();
  assert.equal(index.resolve({ repository: "https://github.com/example/agent-bridge.git" })?.id, "agent-bridge");
  assert.equal(index.resolve({ machineId: "hal", cwd: "/root/projects/hui-radio-v2" })?.id, "hui-radio");
  assert.equal(index.resolve({ machineId: "hal", cwd: "/elsewhere" }), undefined);
  assert.equal(index.room("!travel:example.org:$t")?.id, "travel");
  assert.equal(memory.workIndex(), index, "unchanged scopes keep the snapshot");
  writeFileSync(join(root, "scopes", "hui-radio", "scope.md"), scopeFile("hui-radio", "惠的电台", "  matrix_rooms: []\n  repositories: []\n  locations: []", "") + "\n");
  const next = memory.workIndex();
  assert.notEqual(next.signature, index.signature);
  assert.equal(next.resolve({ machineId: "hal", cwd: "/root/projects/hui-radio-v2" }), undefined);
});

test("a root or home directory binding matches only itself unless it declares prefix; any binding may declare exact", () => {
  const { memory, root } = fixture();
  mkdirSync(join(root, "scopes", "ops"));
  writeFileSync(join(root, "scopes", "ops", "scope.md"), scopeFile("ops", "运维",
    "  matrix_rooms: []\n  repositories: []\n  locations:\n    - {machine: hal, path: /root}\n    - {machine: win, path: 'C:/Users/me'}\n    - {machine: dev, path: /home/me, match: prefix}\n    - {machine: hal, path: /srv/exact, match: exact}"));
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root" }).scope, "ops");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/lunzi" }).scope, "_global");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2/sub" }).scope, "hui-radio", "a deeper prefix binding still covers its tree");
  assert.equal(memory.resolveScope({ machineId: "win", cwd: "C:\\Users\\me\\Documents\\x" }).scope, "_global");
  assert.equal(memory.resolveScope({ machineId: "dev", cwd: "/home/me/work" }).scope, "ops");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/srv/exact/sub" }).scope, "_global");
  memory.bind(hermes, "ops", { location: { machine: "gqx", path: "/data" } });
  const text = readFileSync(join(root, "scopes", "ops", "scope.md"), "utf8");
  assert.match(text, /path: \/home\/me\n\s+match: prefix/);
  assert.doesNotMatch(text, /path: \/root\n\s+match/, "the default is not written out");
});

test("create=true binds an unbound directory as it is, with its repository when it has one, and announces the new scope", async () => {
  const { memory, root } = fixture();
  const { runMemoryTool } = await import("../apps/control-plane/src/mcp/memory.js");
  const { ConversationMemoryStore, Store } = await import("../packages/database/src/index.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-memory-db-")), "control.sqlite"));
  let changed = 0;
  const options = { store: memory, writers: [], onScopesChanged: () => { changed++; } };
  const scope = (args: Record<string, unknown>) => runMemoryTool(new ConversationMemoryStore(store.db), options, "scope", args, hermes) as Promise<any>;
  const located = await scope({ machine_id: "hal", cwd: "/root/projects/挂刀", scope_hint: "steam-trading", title: "挂刀", create: true });
  assert.deepEqual([located.scope, located.matched, located.created, changed], ["steam-trading", "location", true, 1]);
  assert.deepEqual(memory.scope("steam-trading").locations, [{ machine: "hal", path: "/root/projects/挂刀", match: "prefix" }]);
  assert.equal(memory.scope("steam-trading").title, "挂刀");
  assert.deepEqual(memory.scope("steam-trading").repositories, []);
  const both = await scope({ machine_id: "dev", cwd: "/work/thing/", repository: "git@gitea.local:me/Thing.git", scope_hint: "thing", create: true });
  assert.equal(both.scope, "thing");
  assert.deepEqual(memory.scope("thing").repositories, ["gitea.local/me/thing"]);
  assert.deepEqual(memory.scope("thing").locations, [{ machine: "dev", path: "/work/thing", match: "prefix" }]);
  assert.equal(memory.scope("thing").title, "thing", "the directory names it without a title");
  assert.equal((await scope({ machine_id: "dev", cwd: "/work/thing", create: true })).created, false, "a bound directory is resolved, not created again");
  assert.equal(changed, 2);
  assert.ok(!readFileSync(join(root, "scopes", "thing", "scope.md"), "utf8").includes("match:"));
});

test("scope_bind corrects a path binding: add the right one and drop the wrong one in one commit", async () => {
  const { memory, root } = fixture();
  const { runMemoryTool } = await import("../apps/control-plane/src/mcp/memory.js");
  const { ConversationMemoryStore, Store } = await import("../packages/database/src/index.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-memory-db-")), "control.sqlite"));
  let changed = 0;
  const run = (args: Record<string, unknown>) => runMemoryTool(new ConversationMemoryStore(store.db), { store: memory, writers: [], onScopesChanged: () => { changed++; } }, "scope_bind", args, hermes) as Promise<any>;
  const fixed = await run({ scope: "hui-radio", add: { machine_id: "gqx", cwd: "C:\\Work\\Radio" }, remove: { machine_id: "hal", cwd: "/root/projects/hui-radio-v2" } });
  assert.deepEqual(fixed.locations, [{ machine: "gqx", path: "C:/Work/Radio", match: "prefix" }]);
  assert.equal(memory.resolveScope({ machineId: "gqx", cwd: "C:\\Work\\Radio" }).scope, "hui-radio");
  assert.equal(memory.resolveScope({ machineId: "hal", cwd: "/root/projects/hui-radio-v2" }).scope, "_global");
  assert.equal(changed, 1);
  await assert.rejects(run({ scope: "hui-radio", remove: { machine_id: "hal", cwd: "/nowhere" } }), /unknown_location/);
  await assert.rejects(run({ scope: "travel", add: { machine_id: "gqx", cwd: "C:/Work/Radio" } }), /binding_conflict/);
  assert.match(readFileSync(join(root, "scopes", "hui-radio", "scope.md"), "utf8"), /machine: gqx\n\s+path: C:\/Work\/Radio/);
});
