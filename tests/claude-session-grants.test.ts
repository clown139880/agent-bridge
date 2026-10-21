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
