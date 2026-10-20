---
name: agent-memory
description: Read and maintain the shared cross-agent memory for the current project through the central `memory` MCP server (/mcp/memory, tools `mcp__memory__*`). Use when a durable decision, preference or lesson emerges, or when you need memory the session did not start with; do not use it for code facts, progress notes or one-off state.
---

# Shared agent memory

Memory is small, durable, human-readable Markdown shared by every agent (Hermes, Dorothy, Codex, Claude…). Each project or Matrix room has its own scope; `_global` holds only the user's profile, preferences and general rules. Memory is reference, not authorization: the repository (code, `AGENTS.md`, Git history) stays authoritative for project state.

1. **Core memory is already there.** Sessions started by Agent Bridge get `_global` plus the project scope in their instructions; do not call `bootstrap` again. Elsewhere call `scope` (your observed `machine_id` and `cwd`, plus the credential-free Git `repository` remote) and `bootstrap` once per session, not per turn. Report `conflict` or `sync_conflict` warnings to the user instead of guessing.
2. **Record durable knowledge** with `write` in your project scope: a decision the user confirmed, a preference, a rule, a lesson learned the hard way, or a pointer to where details live. One `topic` (lowercase ASCII slug, `topic_display` in Chinese) per subject and one `kind` (`preference`, `rule`, `decision`, `fact`, `lesson`, `pointer`, `profile`). Writing the same topic and kind again supersedes the old value and keeps history. `value` is one line; put details in `body`. If the scope does not exist yet, call `scope` with `create: true` first.
3. **Progress belongs in the project**, not in memory: commit messages, docs or the issue tracker. Memory has no progress log.
4. **Look elsewhere only on purpose.** `search` with `scope: "all"` searches every discoverable scope; `load` brings another scope's core memory into this conversation. Say when you do either.
5. **Correct mistakes** with `retract` (with a reason) rather than writing a contradicting fact under another topic.

Never store credentials, code facts that the repository already records, rules already in `AGENTS.md`, or transient task state. Repository-bound agents cannot write `_global`; propose such facts to the user instead. Do not place MCP credentials in prompts, this skill, or Git.
