# Bridge conversations in the native DSH session tree

Date: 2026-09-11
Target: TokensCowork DSH 0.1.3-alpha.1; development dependencies 0.1.2-rc.1.

## Product contract

The existing DSH Sessions tree is the entry point for both DSH and Bridge
conversations. Users do not import sessions manually, switch to another browser,
or use a replacement composer. Agent Control / Kanban remain management overlays.

Two responsibilities must not be confused:

1. **Session data integration:** discover and organize Bridge sessions, maintain
   stable native identities, project history, attach workspaces, and reconcile
   remote updates into the same native registry that DSH Sessions queries.
2. **Execution provider:** an agent-bridge LlmAdapter routes a bound native
   conversation's prompt and output to its owning Bridge worker.

Registering an LlmAdapter alone does not add anything to the session list.
This was the missing layer in the original implementation.

Bridge owns remote sessions, execution and pending decisions. DSH owns the
presentation projection, native conversation UI and composer. Internal
materialization is an implementation detail, not another user entry point.

## Data path

Bridge workers + paginated sessions
  -> AgentBridgeImportTarget reconciliation
  -> stable native ID / history projection / workspace attachment
  -> DSH AgentRegistry + Session persistence
  -> DSH sessionQuery / original Sessions tree

Native composer
  -> agent-scoped route selection
  -> AgentBridgeLlmAdapter
  -> submit_turn + opaque event cursors + action/turn settlement
  -> DSH stream chunks / native session history

The implementation materializes presentation agents with no remote subprocess
per native agent. Explicit creation or user prompts submit Bridge actions. Initial
retained history is hydrated with four concurrent jobs; subsequent reconciliation
uses changed metadata, live status and per-session cursors. Reconciliation runs
every five seconds and is abortable. An individual session failure does not hide
all other native or Bridge sessions.

This first implementation hydrates retained history eagerly. Lazy cold-session
hydration is a future optimization, not a different UI entry point.

## Identity and workspaces

Native IDs hash the control-plane origin and Bridge sessionId and use an
agent-bridge- namespace. They cannot collide with a raw DSH/Codex ID. The binding
and acknowledged Bridge event IDs live in the native session log, so restart and
repeat reconciliation do not copy the same transcript again.

A directory on a worker whose hostname and platform match the Host can share the existing
native workspace when the directory exists locally. Remote or missing directories
use an isolated presentation directory under ~/.dsh/agent-bridge/workspaces,
keyed by control plane, machine identity and original directory. Those directories contain
no copied project source. The original worker/path remain in the durable binding.
Workers on the same machine can share that location; equal paths on different
machines remain distinct. Existing persisted presentation directories retain
their identity; this release does not rewrite old session headers to merge them.
Windows and WSL remain separate execution locations even when their hostnames match.

The original directory New Session action now opens a source picker through a
narrow, disposable wrapper around the client Sessions.create method. The Host
resolves the directory's binding and advertises only workers on its machine.
DSH is offered only for a real Host directory, never a remote presentation folder.
The Host revalidates the selected source, creates the remote session, materializes
it, and the client refreshes its native list before returning the new identity.
Cancel creates nothing. Offline sources remain visible but cannot be selected.

A future logical project can associate multiple machine/directory locations.
That association and shared project memory are separate from execution routing;
neither is inferred from a matching basename or implemented by this release.

Presentation agents use the empty agent-bridge preset. The provider installs
that preset into the configured writable preset root, refuses to overwrite a
nonempty existing composition, and never inherits local execution tools from a
remote session. Selecting this preset for an unbound new session fails visibly;
it does not silently create a remote session or send to a default local provider.

## Native event contract

Session.append(type, data, {surfaceOp: 'append'}) is the native surface API.
Passing a raw Bridge envelope to append(event) is incorrect.

Completed user/assistant messages and command/file activities become native
user/message, assistant/message, tool/call, and tool/result events.
Imported activity batches use balanced presentation turn/step boundaries and
stable message/tool identities. Native tool results retain actual command/output
fields. The remote tool already ran: its tool call is never yielded to the local
loop as executable work.

Native loop output owns the active local turn. Background history synchronization
pauses while it runs. Message acknowledgements are committed after the native
turn closes, outside Session's non-reentrant append publication. Remaining remote
activity is reconciled after the loop returns idle.

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
  repeat opens, resume, active-turn synchronization, turn completion and errors.
- Verify the bundled running DSH runtime separately from the development pin.
- Bump only the plugin version, commit and push, then install compiled Host and
  browser artifacts using the repository deployment script.
- Do not restart TokensCowork, Bridge or Control Plane for a plugin deployment.
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

The native Bridge model choice follows the remote session. Worker-specific
model catalog selection remains follow-up work. Current-message images are read
through the native attachment store, uploaded to Bridge, and submitted as refs.
Image-only prompts carry a neutral `[Image attached]` text marker for Bridge's
nonempty input contract. Arbitrary file forwarding remains unsupported.
Claude transcript discovery recovers original first-user text, including content
block arrays, using a stable event id and canonical public session identity.
For already-materialized conversations, recovered prompts are appended with a
recovery label; existing native logs are not destructively rewritten. Cold imports
order the recovered prompt by its original timestamp.
History completeness is bounded by what Bridge retains. This plugin cannot
reconstruct events the control plane no longer has.

The old ExternalSessionBrowser/ExternalConversationSurface/ExternalComposer
layer and its master switch are removed. Restoring a parallel session UI is not
the fix for a broken data integration layer.
