# Bridge conversations in the native DSH session tree

Date: 2026-09-11; rewritten for 0.7.3 (virtual sessions, no stored copies).
Target: TokensCowork DSH 0.1.3-alpha.1; development dependencies 0.1.2-rc.1.

## Product contract

The existing DSH Sessions tree is the entry point for both DSH and Bridge
conversations. Users do not import sessions manually, switch to another browser,
or use a replacement composer. Agent Control remains management overlays.

Two responsibilities must not be confused:

1. **Catalog and virtual sessions:** `AgentBridgeImportTarget` reads the Control
   Plane's presentation groups and keeps one catalog binding per Bridge session.
   The client projects them into the native Sessions tree as virtual
   `bridge-remote-*` sessions whose history is read from Bridge on demand
   (`remote-sessions.md`). A remote session is never stored as a native DSH
   session.
2. **Execution provider:** an agent-bridge LlmAdapter routes a bound native
   conversation's prompt and output to its owning Bridge worker. Only a draft
   (below) has a native agent.

Bridge owns remote sessions, execution and pending decisions. DSH owns the
presentation, native conversation UI and composer.

## Data path

Bridge workers + server-paginated presentation groups
  -> AgentBridgeImportTarget catalog bindings + presentation workspaces
  -> client virtual sessions (`bridge-remote-*`, see remote-sessions.md)
  -> DSH sessionQuery / original Sessions tree

Native composer (a draft created in a Bridge project)
  -> agent-scoped route selection
  -> AgentBridgeLlmAdapter
  -> submit_turn + ephemeral live deltas + retained event cursors + action/turn settlement
  -> DSH stream chunks / native session history

Catalog reconciliation runs every five seconds and is abortable; it is skipped
while the Control Plane stream cursor has not moved (with a one-minute backstop).
It only records bindings. A draft is the one native Bridge agent: it lives from
its creation until its first message creates the Bridge session, which the
catalog and the virtual session then show like any other.

## Identity and workspaces

Catalog ids hash the control-plane origin and Bridge sessionId under an
`agent-bridge-` namespace, so they cannot collide with a raw DSH/Codex ID. A
draft gets a random id in the same namespace. Its Bridge binding lives in the
draft's native log; when the first message creates the Bridge session, the
binding gains the session id and a `draft-aliases` sidecar maps the remote id to
the draft's id, so a restart or a later reconciliation never records it twice.

A directory on a worker whose hostname and platform match the Host can share the existing
native workspace when the directory exists locally. Otherwise DSH's workspace contract is
satisfied by an isolated adapter directory under `~/.dsh/agent-bridge/groups`, keyed only by
the Control Plane's stable `groupId`. It contains no copied project source and is not a second
grouping state source. The authoritative group title, aggregate activity, session order and
all physical execution locations come from `GET /session-groups`. The original worker/path
remain in every durable binding. Group workspaces that no catalog group uses any
more, and duplicate presentation workspaces of a group, are deleted.

The original directory New Session action now opens a source picker through a
narrow, disposable wrapper around the client Sessions.create method. The Host
resolves the directory's binding and advertises only workers on its machine.
DSH is offered only for a real Host directory, never a remote presentation folder.
From a presentation folder it is offered in each existing checkout of the group on
this Host instead; choosing it registers that checkout as a DSH workspace, which
the client fuses into the group.
The Host revalidates the selected source and creates only a local draft with its
Bridge binding; the Bridge session is created by the first message, so cancel or
an abandoned draft leaves nothing remote. Offline sources remain visible but cannot be selected.

The client catalog does not infer Bridge groups. It projects the server's `groupId`, and only
fuses native DSH sessions from a real local workspace whose canonical path matches a
server-declared local execution location. Unmatched native sessions remain in their original
DSH groups. Every poll refreshes the catalog position and group fields of all known bindings,
not only of sessions whose own version changed.

Recency uses one clock everywhere: a Bridge session's `activityAt` is the user's last prompt
(`lastPromptAt`, else `createdAt`), the same order as the Control Center; agent replies, tool
progress and status changes do not reorder it. The
sidebar wrapper substitutes `activityAt` for Bridge rows' `updatedAt` in the Session list DSH sorts by, while native DSH sessions keep
their own `updatedAt`. Rows within a group, groups (by their newest row) and the flat list all
rank on that clock. In DSH's `updated` view, the projected order also supersedes DSH 0.1.5's
persisted promotion order (per workspace and `__flat_session_order__`); the `manual` view
remains user-owned.
Rename, delete and drag operations are mapped
back to their original Host workspaces.
Every native session id, original cwd and execution binding is preserved.

Presentation agents use the empty agent-bridge preset. The provider installs
that preset into the configured writable preset root, refuses to overwrite a
nonempty existing composition, and never inherits local execution tools from a
remote session. Selecting this preset for an unbound new session fails visibly;
it does not silently create a remote session or send to a default local provider.

## Titles and deletion

A conversation uses a useful remote title when available, otherwise the first
user message/prompt summary, and finally a short Bridge id. A draft's local log
keeps an explicit title written through DSH's native rename action.

The native sidebar menu retains rename, fork and archive and adds deletion for
the clicked row. A Bridge-bound row waits for the reliable Control Plane action
and owning adapter confirmation before it leaves the catalog (Codex uses App
Server `thread/delete`; Claude forgets the Bridge session). A draft is only
removed locally. A local DSH
row is logically deleted through a durable marker plus native archive; its JSONL
history remains available for recovery and fork lineage. Neither path deletes
project files, and active or pending-interaction sessions must settle first.

## Native event contract

Session.append(type, data, {surfaceOp: 'append'}) is the native surface API.
Passing a raw Bridge envelope to append(event) is incorrect.

A draft's turns, once it is bound, run through the native loop. Completed
user/assistant messages and command/file activities become native
user/message, assistant/message, tool/call, and tool/result events with balanced
presentation turn/step boundaries and stable message/tool identities. Native tool results retain actual command/output
fields. The remote tool already ran: its tool call is never yielded to the local
loop as executable work.

Message acknowledgements are committed after the native turn closes, outside
Session's non-reentrant append publication.

Codex App Server agent-message, reasoning-summary, and plan deltas travel through
a bounded in-memory Control Plane relay and become native DSH text/reasoning
blocks. The relay is intentionally non-durable: authoritative completed items
still use retained session events, close live blocks with final content, and
recover a missed or late item from `turn/completed`. Remote commands are never
emitted as executable DSH tool-call chunks; completed commands remain display-only
tool cards.

A remote subagent or background task (`task.completed`) becomes one display-only
card: `subagent` for an agent, which DSH counts in its turn summary, and
`agent-bridge:task` otherwise. Its own tool calls (events with `parentItemId`)
are not cards. Each is acknowledged with a one-line `step`, and the card lists
those steps under the task's report, even when they arrived in earlier syncs.
They are not nested DSH dispatch events, because the dispatch event type differs
between the DSH releases this plugin supports.

What a remote session is doing right now is shown outside the log. The
`conversation.input.dock` activity bar folds the session's recent `turn.*`,
`progress`, `tool.*`, `task.*` and completion events, which it reads via a type
filter and follows on the realtime stream. It shows the current phase and how
long it has lasted, running subagents and background tasks, and a warning once a
running turn has been silent for 90 seconds. While DSH streams the turn itself
it already shows a thinking indicator with its own clock, so the bar then adds
only the running tool, tasks and warnings. A Bridge before 0.6.77 reports no
phases; the bar then shows the turn's total time and its latest finished step
rather than claiming it waits for the model. It uses the metrics of DSH's own
todo panel. A header button lists running and
recently finished tasks. Neither uses DSH jobs, whose completion can start a
local turn.

The compatibility module isolates the session/store/persistence interfaces.
Both preview lines are checked using real Session replay. The deployed build
uses logical Session format 2; the pinned development build uses format 0.
Do not infer runtime compatibility from TypeScript alone.

## Turn settlement and interactions

The adapter takes an event baseline before submission, preserves expectedTurnId
when steering, follows accepted action receipts, filters events to the resolved
turn, and finishes on that turn's completion. It does not wait for the global
SSE connection to close. Retained history/action polling uses the request's
AbortSignal and opaque forward cursors. Offline/error/failed receipts are visible
failures, never successful empty responses.

Native stop attempts the guarded Bridge interruption for the resolved remote
turn. A failed interruption is logged; cancellation is not represented as proof
the worker stopped.

Pending decisions are requested through the actual agent-scoped native approval
or question services. A binary allow/deny request inside a local running turn
uses native approval; remote-started turns and richer choice sets use native
questions without inventing a DSH execution turn. Cancellation/unavailable is
never translated into an external grant or denial. Before submission, the
request's pending state is rechecked. Secret questions are rejected with a
diagnostic rather than relayed through a non-secret UI.

## Verification and delivery

- Run the package's typecheck, lint, tests and build.
- Test real Session replay, catalog discovery, paging, identity collisions,
  drafts, active-turn synchronization, turn completion and errors.
- Verify the bundled running DSH runtime separately from the development pin.
- Bump only the plugin version, commit and push, then install compiled Host and
  browser artifacts using the repository deployment script.
- Update installed Host and browser bundles without restarting Bridge or Control
  Plane. Restart TokensCowork when the running Host must reload the plugin.
- Verify installed artifact hashes and the actual served UI/provider state.
  Disk hash equality alone does not prove the Host reloaded the provider.

`scripts/verify-runtime.cjs` runs with the installed Electron executable and
`ELECTRON_RUN_AS_NODE=1`, passing the absolute `resources/app.asar` path. It
uses an isolated temporary directory and the actual installed DSH services to
check Agent creation, preset mounting, JSONL persistence, workspace attachment,
resume, and a native turn against a controlled Bridge fixture.

If the running Host response lacks `sessionProvider`, the browser reports that
the Host has not loaded the provider. Refreshing or replacing browser artifacts
cannot activate Host code. Do not assume CLI profile patch watching also applies
to an already-running Desktop Host, or restart Desktop to hide this distinction.

## Current limits

The native model-control seat is session-aware. For Bridge sessions it
loads the bound worker's model catalog and persists the choice as an
`agent-bridge` selection, so the adapter sends that model and reasoning effort
on the next new remote turn. The relay catalog carries no reasoning metadata, so
the menu offers the effort levels of the worker's agent (Claude: low–max, Codex:
low–xhigh, Pi: none) plus the agent default; the default choice is sent as
`reasoningEffort: "default"` because a Bridge session keeps its last level. The
picked level is remembered per session in the client, since the Bridge session
records none. Ordinary DSH sessions continue to use the shared
Host provider catalog. Current-message images are read
through the native attachment store, uploaded to Bridge, and submitted as refs.
Image-only prompts carry a neutral `[Image attached]` text marker for Bridge's
nonempty input contract. Arbitrary file forwarding remains unsupported.

The Bridge model directory is worker-scoped: it can only display models returned
by that worker's adapter. Codex workers currently expose Codex App Server's
`model/list` (primarily GPT models), while Claude and Pi adapters do not yet
publish a model catalog. GPT-prefixed models are therefore filtered out for
non-Codex workers, but other models remain eligible for every Agent. The
`agent-bridge` adapter is also the execution provider for a bound draft.
Pi workers can now expose provider-qualified ids (for example
`deepseek/deepseek-chat`) and switch them on a fresh turn; the selector must
preserve that qualified id. Codex workers still accept the model id from Codex
App Server and cannot switch a Bridge session to an unrelated native DSH
provider through this interception contract.
History completeness is bounded by what Bridge retains. This plugin cannot
reconstruct events the control plane no longer has.

Catalog discovery polls at five-second intervals. An active native turn separately follows its reliable
action receipt, consumes the bounded live-delta relay, and checks its opaque
retained-history cursor for authoritative completion. The removed Client
`SessionStore` SSE surface is not the current provider synchronization path.

The old ExternalSessionBrowser/ExternalConversationSurface/ExternalComposer
layer and its master switch are removed. Restoring a parallel session UI is not
the fix for a broken data integration layer.
