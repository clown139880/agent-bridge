import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../packages/database/src/index.js";
import { ControlPlane } from "../apps/control-plane/src/server.js";
import { makeMemoryBootstrapFetcher } from "../apps/bridge/src/memory-bootstrap.js";

class HeadlessGateway {
  readonly enabled = false; async start() { return ""; } stop() {} async sendRoot() { return ""; }
  async sendThread() { return ""; } async sendReaction() { return ""; } async removeReaction() {} async sendNotice() { return ""; }
}

function vault(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-bootstrap-"));
  const root = join(dir, "agent-memory");
  mkdirSync(join(root, "scopes"), { recursive: true });
  writeFileSync(join(root, "predicates.yaml"), "predicates:\n  - id: rule\n");
  const scope = (id: string, repositories: string, body: string) => {
    mkdirSync(join(root, "scopes", id));
    writeFileSync(join(root, "scopes", id, "scope.md"), `---\ntype: scope\nid: ${id}\ntitle: ${id}\nstatus: active\ndiscoverable: true\n`
      + `bindings:\n  matrix_rooms: []\n  repositories: [${repositories}]\n  locations: []\nbootstrap_budget: 1500\n---\n${body}\n`);
    writeFileSync(join(root, "scopes", id, "entities.md"), "---\ntype: entity-index\nentities: []\n---\n");
  };
  scope("_global", "", "关于你本人。");
  scope("repo-demo", "\"github.com/example/demo\"", "演示项目。");
  return dir;
}

test("a Bridge gets _global plus its project's memory for a new session, and nothing without the token", async () => {
  const dir = vault();
  const repo = mkdtempSync(join(tmpdir(), "memory-bootstrap-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:Example/demo.git"], { cwd: repo });
  const path = join(tmpdir(), `memory-bootstrap-${randomUUID()}.sqlite`), store = new Store(path);
  const control = new ControlPlane(store, new HeadlessGateway(), { host: "127.0.0.1", port: 0, bridgeToken: "bridge-secret",
    agentMemory: { vault: dir, writers: [] } });
  await control.start();
  try {
    const address = (control as unknown as { http: HttpServer }).http.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}/bridge`;
    const text = await makeMemoryBootstrapFetcher(url, "bridge-secret", "dev")(repo);
    assert.ok(text?.startsWith("长期记忆（作用域 repo-demo；"), text);
    assert.ok(text.includes("关于你本人。") && text.includes("演示项目。"));
    // Outside any bound project only _global is shared.
    const other = await makeMemoryBootstrapFetcher(url, "bridge-secret", "dev")(dir);
    assert.ok(other?.includes("作用域 _global") && !other.includes("演示项目。"));
    assert.equal(await makeMemoryBootstrapFetcher(url, "wrong", "dev")(repo), undefined);
  } finally {
    await control.stop(); store.db.close();
    for (const item of [path, dir, repo]) rmSync(item, { recursive: true, force: true });
  }
});
