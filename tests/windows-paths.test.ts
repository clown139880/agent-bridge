import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPathWithinRoots, splitAllowedRoots } from "../apps/bridge/src/path-utils.js";

test("Windows allowed roots use semicolons and preserve drive letters", () => {
  assert.deepEqual(splitAllowedRoots("C:\\Users\\clown\\Workspace;D:\\Projects", "win32"), ["C:\\Users\\clown\\Workspace", "D:\\Projects"]);
});

test("Windows path containment rejects traversal, sibling prefixes, and other drives", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-win-path-"));
  const project = join(root, "project");
  const sibling = join(root, "project-copy");
  mkdirSync(project); mkdirSync(sibling);
  assert.equal(isPathWithinRoots(project, [root], "win32"), true);
  assert.equal(isPathWithinRoots(join(project, "..", "project"), [root], "win32"), true);
  assert.equal(isPathWithinRoots(sibling, [project], "win32"), false);
  assert.equal(isPathWithinRoots("D:\\outside", [root], "win32"), false);
  rmSync(root, { recursive: true, force: true });
});
