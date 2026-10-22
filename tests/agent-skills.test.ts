import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AgentMemory, AgentSkills, MemoryError, type Writer } from "../packages/agent-memory/src/index.js";

const dorothy: Writer = { name: "dorothy", role: "agent" };
const codex: Writer = { name: "codex@wsl", role: "project" };

function skillMd(name: string, description: string, extra = "", body = "正文"): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n${extra}---\n\n${body}\n`;
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture(options: { git?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "agent-skills-"));
  put(repo, "scopes/_global/media/openlist/SKILL.md", skillMd("openlist", "OpenList 分享与外链"));
  put(repo, "scopes/_global/media/openlist/references/share-hosting.md", "链接规则\n");
  put(repo, "scopes/_agent-dorothy/media/navidrome/SKILL.md", skillMd("navidrome", "Navidrome 歌单",
    "metadata:\n  agent_skills:\n    pinned: true\n"));
  put(repo, "scopes/velvet-room/aigc/aigc-studio/SKILL.md", skillMd("aigc-studio", "AIGC 合集"));
  put(repo, "scopes/velvet-room/aigc/aigc-studio/references/h3/GUIDE.md", "H3 分区\n");
  // A SKILL.md below another skill is part of that skill, not a skill of its own.
  put(repo, "scopes/velvet-room/aigc/aigc-studio/references/legacy/SKILL.md", skillMd("legacy", "不该被列出"));
  put(repo, "scopes/velvet-room/media/navidrome/SKILL.md", skillMd("navidrome", "房间里的同名技能"));
  put(repo, "scopes/card-negumi/persona/negumi/SKILL.md",
    skillMd("negumi", "角色卡", "metadata:\n  agent_skills:\n    slash: true\n"));
  mkdirSync(join(repo, "scopes/travel"));
  if (options.git) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
  }
  const archiveDir = join(mkdtempSync(join(tmpdir(), "agent-skills-archive-")), "archive");
  const skills = new AgentSkills({ repo, archiveDir, lockPath: options.git ? join(repo, ".git", "skills.lock") : undefined,
    now: () => new Date("2026-10-14T08:00:00Z") });
  return { repo, archiveDir, skills };
}

const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

test("index lists skills of the given scopes in order; earlier scopes win name clashes", () => {
  const { skills } = fixture();
  const index = skills.index(["velvet-room", "_global", "_agent-dorothy"]);
  assert.deepEqual(index.map((item) => `${item.scope}/${item.name}`),
    ["velvet-room/aigc-studio", "velvet-room/navidrome", "_global/openlist"]);
  assert.equal(index[0]!.category, "aigc");
  assert.equal(index[0]!.path, "scopes/velvet-room/aigc/aigc-studio");
  assert.ok(!skills.skills().some((item) => item.name === "legacy"));
  assert.equal(skills.skills().find((item) => item.name === "negumi")!.slash, true);
  assert.deepEqual(skills.skills().filter((item) => item.pinned).map((item) => `${item.scope}/${item.name}`),
    ["_agent-dorothy/navidrome"]);
});

test("view returns the skill directory, its files and one file's content; paths cannot escape", () => {
  const { skills, repo } = fixture();
  const view = skills.view("openlist", ["_global"]);
  assert.equal(view.dir, join(repo, "scopes/_global/media/openlist"));
  assert.deepEqual(view.files, ["SKILL.md", "references/share-hosting.md"]);
  assert.match(view.content, /^---\nname: openlist/);
  assert.equal(skills.view("openlist", "all", "references/share-hosting.md").content, "链接规则\n");
  assert.throws(() => skills.view("openlist", "all", "../../_agent-dorothy/media/navidrome/SKILL.md"), /invalid_file_path/);
  assert.throws(() => skills.view("aigc-studio", ["_global"]), /unknown_skill/);
});

test("search ranks name over description over body and respects scopes", () => {
  const { skills } = fixture();
  assert.deepEqual(skills.search("navidrome", "all").map((hit) => hit.scope), ["_agent-dorothy", "velvet-room"]);
  assert.deepEqual(skills.search("歌单", ["_agent-dorothy"]).map((hit) => hit.name), ["navidrome"]);
  assert.deepEqual(skills.search("", "all"), []);
});

test("write creates a skill from its SKILL.md and commits only that skill", () => {
  const { skills, repo } = fixture({ git: true });
  writeFileSync(join(repo, "unrelated.txt"), "dirty");
  assert.throws(() => skills.write(dorothy, { scope: "travel", name: "visa", file: "notes.md", content: "x" }), /unknown_skill/);
  assert.throws(() => skills.write(dorothy, { scope: "travel", name: "visa", content: skillMd("other", "d") }), /skill_name_mismatch/);
  assert.throws(() => skills.write(dorothy, { scope: "travel", name: "visa", content: "---\nname: visa\n---\n" }), /description_required/);
  const created = skills.write(dorothy, { scope: "travel", name: "visa", category: "trip", content: skillMd("visa", "签证材料") });
  assert.equal(created.path, "scopes/travel/trip/visa");
  assert.equal(created.commit, git(repo, "rev-parse", "HEAD"));
  assert.deepEqual(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n"), ["scopes/travel/trip/visa/SKILL.md"]);
  assert.match(git(repo, "log", "-1", "--format=%an%n%B"), /^agent-skills \(dorothy\)\nskill\(travel\/visa\): write SKILL.md\n\nby: dorothy/);
  assert.match(git(repo, "status", "--porcelain"), /unrelated\.txt/);

  skills.write(dorothy, { scope: "travel", name: "visa", file: "references/list.md", content: "护照\n" });
  assert.equal(readFileSync(join(repo, "scopes/travel/trip/visa/references/list.md"), "utf8"), "护照\n");
  assert.throws(() => skills.write(dorothy, { scope: "travel", name: "visa", file: "references/x/SKILL.md", content: "x" }),
    /nested_skill_md/);
  assert.throws(() => skills.write(dorothy, { scope: "_global", name: "visa", content: skillMd("visa", "d") }),
    /skill_exists_in_other_scope/);
});

test("credentials are rejected and project writers cannot write underscore scopes", () => {
  const { skills } = fixture();
  assert.throws(() => skills.write(dorothy, { scope: "travel", name: "keys", content: skillMd("keys", "d", "", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz") }),
    (error: unknown) => error instanceof MemoryError && error.code === "secret_rejected");
  assert.throws(() => skills.write(codex, { scope: "_global", name: "x", content: skillMd("x", "d") }), /forbidden/);
  assert.throws(() => skills.patch(codex, { name: "openlist", scopes: "all", oldText: "正文", newText: "新" }), /forbidden/);
  assert.equal(skills.write(codex, { scope: "travel", name: "x", content: skillMd("x", "d") }).scope, "travel");
});

test("patch replaces exactly one occurrence unless replace_all", () => {
  const { skills, repo } = fixture();
  skills.write(dorothy, { scope: "travel", name: "trip", content: skillMd("trip", "d", "", "A\nA\nB") });
  assert.throws(() => skills.patch(dorothy, { name: "trip", scopes: "all", oldText: "C", newText: "D" }), /old_text_not_found/);
  assert.throws(() => skills.patch(dorothy, { name: "trip", scopes: "all", oldText: "A", newText: "Z" }), /old_text_ambiguous/);
  skills.patch(dorothy, { name: "trip", scopes: "all", oldText: "B", newText: "$& kept" });
  skills.patch(dorothy, { name: "trip", scopes: "all", oldText: "A", newText: "Z", replaceAll: true });
  assert.match(readFileSync(join(repo, "scopes/travel/general/trip/SKILL.md"), "utf8"), /Z\nZ\n\$& kept/);
  assert.throws(() => skills.patch(dorothy, { name: "trip", scopes: "all", oldText: "name: trip", newText: "name: other" }),
    /skill_name_mismatch/);
});

test("archive moves a skill out of the library and move changes its scope", () => {
  const { skills, repo, archiveDir } = fixture({ git: true });
  assert.throws(() => skills.removeFile(dorothy, { name: "openlist", scopes: "all", file: "SKILL.md" }), /use_archive_for_skill_md/);
  skills.removeFile(dorothy, { name: "openlist", scopes: "all", file: "references/share-hosting.md" });
  assert.ok(!existsSync(join(repo, "scopes/_global/media/openlist/references/share-hosting.md")));

  const moved = skills.move(dorothy, { name: "navidrome", scopes: ["_agent-dorothy"], to: "travel" });
  assert.equal(moved.path, "scopes/travel/media/navidrome");
  assert.ok(!existsSync(join(repo, "scopes/_agent-dorothy/media")));
  assert.throws(() => skills.move(dorothy, { name: "navidrome", scopes: ["velvet-room"], to: "travel" }), /target_exists/);

  const archived = skills.archive(dorothy, { name: "aigc-studio", scopes: "all", reason: "抽成项目" });
  assert.ok(existsSync(join(archived.archivedTo, "references/h3/GUIDE.md")));
  assert.ok(archived.archivedTo.startsWith(archiveDir));
  assert.ok(!existsSync(join(repo, "scopes/velvet-room/aigc")));
  assert.match(git(repo, "log", "-1", "--format=%B"), /archive\n\n抽成项目/);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("MCP exposes skill tools to agent tokens and keeps project agents out of the shared scopes", async () => {
  const { skills } = fixture();
  const vault = mkdtempSync(join(tmpdir(), "agent-skills-vault-"));
  put(vault, "agent-memory/scopes/_global/scope.md", "---\ntype: scope\nid: _global\ntitle: 全局\nstatus: active\n---\n");
  const memory = new AgentMemory({ vault });
  const { ConversationMcpServer } = await import("../apps/control-plane/src/memory-mcp.js");
  const { ConversationMemoryStore, Store } = await import("../packages/database/src/index.js");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-skills-db-")), "control.sqlite"));
  const writers = [{ name: "dorothy", role: "agent" as const, token: "dorothy-token-0123456789" },
    { name: "codex@wsl", role: "project" as const, token: "codex-token-0123456789" }];
  const withSkills = new ConversationMcpServer(new ConversationMemoryStore(store.db), { store: memory, skills, writers });
  const withoutSkills = new ConversationMcpServer(new ConversationMemoryStore(store.db), { store: memory, writers });
  const dispatch = (server: unknown, token: string, method: string, params?: unknown) => {
    const target = server as { authenticate(header: string): unknown; dispatch(raw: unknown, principal: unknown): Promise<any> };
    return target.dispatch({ jsonrpc: "2.0", id: 1, method, params }, target.authenticate(`Bearer ${token}`));
  };
  const names = async (server: unknown, token: string) =>
    (await dispatch(server, token, "tools/list")).result.tools.map((tool: { name: string }) => tool.name) as string[];
  try {
    assert.ok((await names(withSkills, "codex-token-0123456789")).includes("skill_view"));
    assert.ok((await names(withSkills, "dorothy-token-0123456789")).includes("skill_write"));
    assert.ok(!(await names(withoutSkills, "dorothy-token-0123456789")).some((name) => name.startsWith("skill_")));

    const call = (token: string, name: string, args: Record<string, unknown>) =>
      dispatch(withSkills, token, "tools/call", { name, arguments: args });
    const index = await call("codex-token-0123456789", "skill_index", { scopes: ["_agent-dorothy", "_global"] });
    assert.deepEqual(index.result.structuredContent.skills.map((item: { name: string }) => item.name), ["navidrome", "openlist"]);
    const view = await call("codex-token-0123456789", "skill_view", { name: "navidrome", scopes: ["velvet-room"] });
    assert.match(view.result.structuredContent.content, /房间里的同名技能/);
    assert.match((await call("codex-token-0123456789", "skill_write",
      { scope: "_global", name: "x", content: skillMd("x", "d") })).error.message, /forbidden/);
    const written = await call("dorothy-token-0123456789", "skill_write", { scope: "travel", name: "x", content: skillMd("x", "d") });
    assert.equal(written.result.structuredContent.path, "scopes/travel/general/x");
    assert.match((await call("codex-token-0123456789", "skill_search", { query: "x", scopes: "nope" })).error.message,
      /invalid_string_array_argument/);
  } finally {
    store.db.close();
  }
});
