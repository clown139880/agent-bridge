import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeCodeAdapter } from "../apps/bridge/src/claude/claude-adapter.js";

function adapter(autoApprove: { mode: "off" | "readonly" | "all"; tools: string[] }) {
  const instance = new ClaudeCodeAdapter(
    { command: "claude", claudeHome: "/tmp", allowedRoots: ["/tmp"], scanExisting: false, autoApprove },
    () => {},
  );
  return instance as unknown as { isAutoApproved(tool: string): boolean };
}

test("native permissions option is accepted and does not alter the bridge gate", () => {
  // Native allow/deny/mode are enforced inside the claude subprocess (before the gate),
  // so the bridge-side isAutoApproved must stay driven purely by autoApprove.
  const instance = new ClaudeCodeAdapter(
    {
      command: "claude",
      claudeHome: "/tmp",
      allowedRoots: ["/tmp"],
      scanExisting: false,
      autoApprove: { mode: "off", tools: [] },
      permissions: { mode: "acceptEdits", allow: ["Bash(git:*)"], deny: ["Read(~/.ssh/**)"], additionalDirectories: ["/srv"] },
    },
    () => {},
  ) as unknown as { isAutoApproved(tool: string): boolean };
  assert.equal(instance.isAutoApproved("Bash"), false);
  assert.equal(instance.isAutoApproved("Edit"), false);
});

test("auto-approve off prompts for every tool", () => {
  const a = adapter({ mode: "off", tools: [] });
  assert.equal(a.isAutoApproved("Read"), false);
  assert.equal(a.isAutoApproved("Bash"), false);
});

test("auto-approve readonly clears non-mutating built-ins but not high-risk tools", () => {
  const a = adapter({ mode: "readonly", tools: [] });
  assert.equal(a.isAutoApproved("Read"), true);
  assert.equal(a.isAutoApproved("Grep"), true);
  assert.equal(a.isAutoApproved("WebFetch"), true);
  assert.equal(a.isAutoApproved("Bash"), false);
  assert.equal(a.isAutoApproved("Write"), false);
  assert.equal(a.isAutoApproved("Edit"), false);
  assert.equal(a.isAutoApproved("Task"), false);
});

test("auto-approve all clears everything", () => {
  const a = adapter({ mode: "all", tools: [] });
  assert.equal(a.isAutoApproved("Bash"), true);
  assert.equal(a.isAutoApproved("Write"), true);
});

test("explicit tools allowlist clears on top of the mode", () => {
  const a = adapter({ mode: "readonly", tools: ["Bash"] });
  assert.equal(a.isAutoApproved("Bash"), true);
  assert.equal(a.isAutoApproved("Write"), false);
});
