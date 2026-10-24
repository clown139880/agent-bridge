import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { ClaudeCodeAdapter } from "../apps/bridge/src/claude/claude-adapter.js";

type Seam = {
  sessions: Map<string, unknown>;
  grantsFor(sessionId: string): Set<string>;
  handleToolPermission(session: unknown, tool: string, input: unknown, signal: AbortSignal): Promise<{ behavior: string }>;
};

test("claude: allow-session grants survive the session being reaped and revived, and end with deletion", async () => {
  const adapter = new ClaudeCodeAdapter({ command: "", claudeHome: tmpdir(), allowedRoots: [tmpdir()], scanExisting: false }, () => {});
  const seam = adapter as unknown as Seam;
  // The fields handleToolPermission/approve touch; launch() builds the rest.
  const live = () => {
    const session = { sessionId: "s", abort: new AbortController(), input: { end() {} }, turnSeq: 0, turnTextSeq: 0, logs: [], pendingApprovals: new Map(), sessionAllowedTools: seam.grantsFor("s") };
    seam.sessions.set("s", session);
    return session;
  };
  const first = live();
  const asked = seam.handleToolPermission(first, "WebFetch", { url: "https://example.com" }, new AbortController().signal);
  const [approvalId] = first.pendingApprovals.keys();
  await adapter.approve("s", approvalId as string, "allow-session");
  assert.equal((await asked).behavior, "allow");

  seam.sessions.delete("s"); // idle reap / dead subprocess
  const revived = live();
  assert.equal((await seam.handleToolPermission(revived, "WebFetch", {}, new AbortController().signal)).behavior, "allow");
  assert.equal(revived.pendingApprovals.size, 0);

  await adapter.deleteSessionAction("s");
  assert.equal(seam.grantsFor("s").size, 0);
});

test("claude: allow-always clears the tool for every session and persists it in Claude's settings.json; never offered for command or edit tools", async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "claude-home-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["mcp__memory"], deny: ["Bash(rm:*)"] } }));
    const events: Array<Record<string, unknown>> = [];
    const adapter = new ClaudeCodeAdapter({ command: "", claudeHome: home, allowedRoots: [home], scanExisting: false }, e => events.push(e as Record<string, unknown>));
    const seam = adapter as unknown as Seam;
    const live = (id: string) => {
      const session = { sessionId: id, abort: new AbortController(), input: { end() {} }, turnSeq: 0, turnTextSeq: 0, logs: [], pendingApprovals: new Map(), sessionAllowedTools: seam.grantsFor(id) };
      seam.sessions.set(id, session);
      return session;
    };
    const first = live("a");
    const asked = seam.handleToolPermission(first, "mcp__bridge__sessions", { limit: 5 }, new AbortController().signal);
    const request = events.find(e => e.type === "approval_request")!;
    assert.deepEqual(request.choices, ["allow", "deny", "allow-session", "allow-always"]);
    assert.equal(request.summary, 'mcp__bridge__sessions {"limit":5}');
    await adapter.approve("a", [...first.pendingApprovals.keys()][0] as string, "allow-always");
    assert.equal((await asked).behavior, "allow");
    // Another session never asks, and the rule joins the others without disturbing the file.
    assert.equal((await seam.handleToolPermission(live("b"), "mcp__bridge__sessions", {}, new AbortController().signal)).behavior, "allow");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")),
      { model: "opus", permissions: { allow: ["mcp__memory", "mcp__bridge__sessions"], deny: ["Bash(rm:*)"] } });

    void seam.handleToolPermission(first, "Bash", { command: "ls" }, new AbortController().signal);
    assert.deepEqual(events.filter(e => e.type === "approval_request").at(-1)!.choices, ["allow", "deny", "allow-session"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
