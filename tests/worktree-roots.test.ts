import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isWorkspaceWithinRoots } from "../apps/bridge/src/path-utils.js";
import { resolveProjectPath } from "../apps/bridge/src/app-server.js";

test("allowed repository admits its registered worktree but rejects copied pointers and unrelated workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-worktree-"));
  try {
    const repo = join(root, "allowed"), worktree = join(root, "desktop"), fake = join(root, "fake");
    mkdirSync(repo); mkdirSync(fake);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("init"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "init");
    git("worktree", "add", "--detach", worktree);
    assert.equal(isWorkspaceWithinRoots(repo, [repo]), true);
    assert.equal(isWorkspaceWithinRoots(worktree, [repo]), true);
    assert.equal(await resolveProjectPath(worktree, [repo]), worktree);
    assert.equal(isWorkspaceWithinRoots(worktree, [fake]), false);
    writeFileSync(join(fake, ".git"), readFileSync(join(worktree, ".git")));
    assert.equal(isWorkspaceWithinRoots(fake, [repo]), false);
    rmSync(join(worktree, ".git"));
    writeFileSync(join(worktree, ".git"), "gitdir: missing\n");
    assert.equal(isWorkspaceWithinRoots(worktree, [repo]), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
