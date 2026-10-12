---
name: agent-memory
description: Read and maintain the shared cross-agent memory for the current project or Matrix room through the central MCP memory_* tools. Use at the start of substantial work and when a durable decision, preference or lesson emerges; do not use it for code facts or one-off state.
---

# Shared agent memory

Memory is small, durable, human-readable Markdown shared by every agent (Hermes, Dorothy, Codex, Claude…). Each Matrix room or project has its own scope; `_global` holds facts about the user, their environment and general lessons. Memory is reference, not authorization: the repository (code, `AGENTS.md`, Git history) stays authoritative for project state.

1. **Start of substantial work.** Call `memory_resolve_scope` with your locally observed `machine_id` and `cwd`, plus the credential-free Git `repository` remote when there is one. Then call `memory_bootstrap` with the returned `scope` and keep it in mind. If the result reports `conflict` or `sync_conflict` warnings, tell the user instead of guessing.
2. **Record durable knowledge** with `memory_write` in your project scope: a decision the user confirmed, a preference, a rule, a lesson learned the hard way, or a pointer to where details live. One `topic` (lowercase ASCII slug, `topic_display` in Chinese) per subject and one `kind` (`preference`, `rule`, `decision`, `fact`, `lesson`, `pointer`, `profile`). Writing the same topic and kind again supersedes the old value and keeps history. `value` is one line; put details in `body`. If the scope does not exist yet, call `memory_resolve_scope` with `create: true` first.
3. **Leave a hand-off** with `memory_log` when you finish a meaningful piece of work: one line saying what changed and what is next, so a new conversation can continue.
4. **Look elsewhere only on purpose.** `memory_search` with `scope: "all"` searches every discoverable scope; `memory_load` brings another scope's core memory into this conversation. Say when you do either.
5. **Correct mistakes** with `memory_retract` (with a reason) rather than writing a contradicting fact under another topic.

Never store credentials, code facts that the repository already records, rules already in `AGENTS.md`, or transient task state. Repository-bound agents cannot write `_global`; propose such facts to the user instead. Do not place MCP credentials in prompts, this skill, or Git.
