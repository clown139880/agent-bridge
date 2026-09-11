# Agent Bridge Worker for Hermes

This plugin dispatches Hermes Kanban cards assigned to `codex@machine` through Agent Bridge and relays remote approvals back to Hermes.

## Worker lanes (`worker_prefix`)

The plugin only dispatches, claims, and relays approvals for cards whose assignee starts with one of its configured lane prefixes. `worker_prefix` defaults to `codex@` and accepts a comma-separated list so one worker can serve several lanes at once:

```yaml
worker_prefix: "codex@,claude@"
```

Matching is case-insensitive. With the example above, both the default `codex@machine` lane and the `claude@machine` special-forces lane are claimed; a card assigned to `claude@hal` under a `codex@`-only config stays READY and is never picked up.

## Read-only session tools

- `agent_bridge_sessions(workerId?, workspace?, q?, taskId?, active?, limit?)` searches `GET /api/v1/sessions` for a session to resume.
- `agent_bridge_session_context(sessionId)` reads `GET /api/v1/sessions/{id}` and the tail of `GET /api/v1/sessions/{id}/events?tail=true`.

Both tools are read-only. A typical Matrix flow is to search for sessions, inspect the likely session's context, and then put its Control Plane `sessionId` into the target card body.

## Resuming a session from a card

Add exactly this HTML comment to the card body:

```html
<!-- agent-bridge-worker
resume-session-id: <Control Plane sessionId>
-->
```

The supervisor passes that ID as `resumeSessionId`; the Control Plane remains responsible for checking that the session exists, is not busy, and matches the selected machine and workspace. A malformed, empty, or duplicate directive blocks dispatch with a clear error instead of silently starting a different session.

Without a directive, the card starts a new session under `hermes-task:{board}:{task.id}`. That card-level conversation ID makes retries of the same card resumable, but deliberately prevents separate cards from the same Matrix room from automatically sharing a session. DSH-created sessions remain independent and are not assigned a Hermes `conversationId`.
