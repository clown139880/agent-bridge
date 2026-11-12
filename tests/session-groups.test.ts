import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentMemory } from "../packages/agent-memory/src/index.js";
import { AgentControlStore, Store } from "../packages/database/src/index.js";

function fixture() {
  const path = join(tmpdir(), `agent-bridge-groups-${randomUUID()}.sqlite`);
  const store = new Store(path);
  for (const id of ["dev", "win"]) store.upsertMachine({ id, name: id, platform: "linux", hostname: id, capabilities: [] });
  const control = new AgentControlStore(store.db, { actionsMs: 1_000, attachmentsMs: 1_000 });
  const create = (id: string, machineId: string, projectPath: string, updatedAt: number, identity?: string) => {
    control.upsertSession(machineId, { sessionId: id, agentType: "codex-cli", projectName: projectPath.split(/[\\/]/).at(-1)!, projectPath,
      nativeSessionId: id, status: "completed", activityStatus: "idle", source: "app-server", historyCompleteness: "complete",
      createdAt: 1, updatedAt } as never);
    control.setProjectIdentity(id, identity);
  };
  return { store, control, create, close: () => { store.db.close(); rmSync(path, { force: true }); } };
}

/** The grouping before 0.7.83, inferred over the whole table on every read. */
function inferredGroupIds(store: Store): Map<string, string> {
  const rows = store.db.prepare(`WITH inferred AS (SELECT s.*,COALESCE(NULLIF(TRIM(s.project_identity),''),(
      SELECT CASE WHEN COUNT(DISTINCT NULLIF(TRIM(p.project_identity),''))=1 THEN MIN(NULLIF(TRIM(p.project_identity),'')) END
      FROM sessions p WHERE p.machine_id=s.machine_id AND p.project_path=s.project_path)) AS resolved_identity FROM sessions s)
    SELECT id,CASE WHEN resolved_identity IS NOT NULL THEN 'repository'||char(31)||resolved_identity
      ELSE 'location'||char(31)||machine_id||char(31)||project_path END AS group_key FROM inferred`).all() as Array<{ id: string; group_key: string }>;
  return new Map(rows.map((row) => [row.id, (row.group_key.startsWith("repository") ? "repo:" : "loc:")
    + createHash("sha256").update(row.group_key).digest("base64url").slice(0, 22)]));
}

function populate(create: ReturnType<typeof fixture>["create"]) {
  create("repo-dev", "dev", "/work/repo", 400, "git@github.com:example/repo.git");
  create("repo-win", "win", "D:\\repo", 500, "https://github.com/example/repo");
  create("repo-legacy", "dev", "/work/repo", 450);
  create("conflict-a", "dev", "/work/conflict", 300, "github.com/example/first");
  create("conflict-b", "dev", "/work/conflict", 310, "github.com/example/second");
  create("conflict-legacy", "dev", "/work/conflict", 320);
  create("plain", "dev", "/work/plain", 200);
  create("scratch", "win", "C:\\Users\\me\\Documents\\Codex\\2026-11-01\\x", 100);
}

test("without a scope the stored groups are the groups the old inference read", () => {
  const f = fixture();
  try {
    populate(f.create);
    const expected = inferredGroupIds(f.store);
    for (const [id, groupId] of expected) assert.equal(f.control.session(id)?.groupId, groupId, id);
    const listed = f.control.listSessionGroups({ limit: 50 }).data;
    for (const group of listed) for (const session of group.sessions as Array<{ sessionId: string }>)
      assert.equal(group.groupId, expected.get(session.sessionId));
    assert.equal(f.control.session("repo-legacy")?.projectIdentity, "github.com/example/repo");
    assert.equal(f.control.session("conflict-legacy")?.projectIdentity, undefined);
  } finally { f.close(); }
});

test("a memory scope groups its repositories and locations, titled by the scope", () => {
  const f = fixture();
  try {
    populate(f.create);
    f.control.groupScope = (locator) => locator.repository === "github.com/example/repo" || locator.path === "/work/plain"
      ? { id: "example", title: "示例项目" } : undefined;
    f.control.regroupAll();
    const session = f.control.session("repo-legacy")!;
    assert.equal(session.groupId, "scope:example");
    assert.equal(session.groupTitle, "示例项目");
    assert.equal((session.presentationGroup as { kind: string }).kind, "scope");
    assert.equal(session.groupUpdatedAt, 500);
    assert.deepEqual((session.executionLocations as Array<{ workspace: string }>).map((item) => item.workspace), ["D:\\repo", "/work/repo", "/work/plain"]);
    const group = f.control.listSessionGroups({ limit: 1 }).data[0]!;
    assert.deepEqual((group.sessions as Array<{ sessionId: string }>).map((item) => item.sessionId), ["repo-win", "repo-legacy", "repo-dev", "plain"]);
    assert.equal(f.control.session("conflict-a")?.groupId, inferredGroupIds(f.store).get("conflict-a"), "an unbound session keeps its old group");
    // A later session at a bound location joins the scope on write.
    f.create("plain-2", "dev", "/work/plain", 600);
    assert.equal(f.control.session("plain-2")?.groupId, "scope:example");
  } finally { f.close(); }
});

test("editing a scope.md regroups the sessions it binds or releases, and announces only those", () => {
  const f = fixture();
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-groups-"));
  const dir = join(vault, "agent-memory", "scopes");
  const scope = (id: string, title: string, bindings: string) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "scope.md"), `---\ntype: scope\nid: ${id}\ntitle: ${title}\nstatus: active\nbindings:\n${bindings}\n---\n`);
  };
  try {
    scope("_global", "全局", "  rooms: []\n  repositories: []\n  locations: []");
    scope("radio", "电台", "  rooms: []\n  repositories: [\"https://gitea.example.org:8443/me/radio.git\"]\n  locations: []");
    const memory = new AgentMemory({ vault });
    let index = memory.workIndex();
    f.control.groupScope = (locator) => {
      const hit = index.resolve({ repository: locator.repository, machineId: locator.machineId, cwd: locator.path });
      return hit && !hit.id.startsWith("_") ? { id: hit.id, title: hit.title } : undefined;
    };
    f.create("radio", "dev", "/work/radio", 100, "gitea.example.org:8443/me/radio");
    f.create("radio-sub", "dev", "/work/radio/agent/audience", 110, "gitea.example.org:8443/me/radio");
    f.create("notes", "dev", "/work/notes", 120);
    assert.equal(f.control.session("radio-sub")?.groupId, "scope:radio");
    assert.notEqual(f.control.session("notes")?.groupId, "scope:radio");

    scope("radio", "惠的电台", "  rooms: []\n  repositories: []\n  locations:\n    - {machine: dev, path: /work/notes}");
    index = memory.workIndex();
    const before = f.control.streamPosition();
    assert.equal(f.control.regroupAll(), 3);
    const changed = f.control.streamAfter(before).items.map((item) => item.resourceId).sort();
    assert.deepEqual(changed, ["notes", "radio", "radio-sub"]);
    assert.equal(f.control.session("notes")?.groupTitle, "惠的电台");
    assert.equal(f.control.session("radio")?.groupId, inferredGroupIds(f.store).get("radio"));
    assert.equal(f.control.regroupAll(), 0, "an unchanged index moves nothing");
  } finally { f.close(); rmSync(vault, { recursive: true, force: true }); }
});
