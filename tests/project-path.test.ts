import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProjectPath } from "../apps/bridge/src/app-server.js";

test("resolveProjectPath keeps valid absolute paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-path-"));
  const project = join(root, "project");
  mkdirSync(project);
  let queried = false;
  try {
    const result = await resolveProjectPath(project, [root], async () => {
      queried = true;
      return project;
    });
    assert.equal(result, realpathSync(project));
    assert.equal(queried, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectPath resolves plain and z-prefixed fuzzy paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-path-"));
  const project = join(root, "agent-bridge");
  mkdirSync(project);
  try {
    for (const [input, expectedQuery] of [["agent-bridge", "agent-bridge"], ["z:agent-bridge", "agent-bridge"]]) {
      const result = await resolveProjectPath(input, [root], async (query) => {
        assert.equal(query, expectedQuery);
        return `${project}\n`;
      });
      assert.equal(result, realpathSync(project));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProjectPath still rejects fuzzy matches outside allowed roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-root-"));
  const outside = mkdtempSync(join(tmpdir(), "agent-bridge-outside-"));
  try {
    await assert.rejects(
      resolveProjectPath("outside", [root], async () => outside),
      /outside BRIDGE_ALLOWED_ROOTS/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
