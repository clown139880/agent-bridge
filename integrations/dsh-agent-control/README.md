# DSH Agent Control Plugin

An installable, out-of-tree DeepSeek Harness bundle that adds an Agent Bridge
control surface and a Hermes Kanban workspace without patching DSH itself.

Compatibility is pinned and tested against the published DSH developer preview
`0.1.2-rc.1`, Cordis `4.0.2`, Node `^22.19.0 || >=24`, and pnpm `11.7.0`.

## What it provides

- Sidebar **Agent Control** and **Kanban** shortcuts opening an additive `shell.overlay` workspace.
- Overview and Hermes Kanban views; DSH / Bridge source switching places external sessions in the main sidebar and conversation area.
- Kanban loads independently of Bridge overview and hides empty columns by default, with a toggle to reveal them.
- Paginated Sessions browser with workspace/flat grouping, loaded-title/path search,
  attention filtering, and chronological history continuation beyond the first 200 events.
- DSH-native `MarkdownText` and `TerminalBlock` presentation, file-change details,
  turn boundaries/summaries, and an optional raw-event view with real event timestamps.
- Per-session drafts and async state, auto steer/start submission with `expectedTurnId`, interruption,
  approvals, structured input discovery, task creation/details/comments/runs, and real assignee selection.
- 24 registered model tools covering workers/sessions/events/actions/pending requests and
  Kanban query/create/comment/dependency/review/operator operations.
- One Host-owned `AgentControlService` shared by UI requests and model tools.
- Live and mock Bridge transports, plus sidecar/HTTP/mock Kanban transports.

On DSH `0.1.3-alpha.1`, the Bridge composer uses the public `ExternalComposer`:
the same Lexical contenteditable, plain-text/history registration, keyboard map,
placeholder, send control, CSS module, and layout seat as the native InputBar.
Only the controlled draft and submit target are injected by the Bridge adapter.
Older releases retain the textarea/Button compatibility path. A UI regression
test covers project creation and sending through the public composer contract.
The transcript and composer consume ConversationRoot's published content width,
composer width/clearance, bubble, input surface, elevation, typography, and action
color variables. Entering Bridge expands a collapsed sidebar once so the external
session browser is immediately available. Structural turn boundary events remain
available in raw mode but do not add empty rows to the normal transcript.
The current external composer intentionally exposes plain text only. Attachments,
slash commands, references, permission/model controls, and the full native reader
still require target-neutral capability adapters; unsupported controls are not
shown. Its public `modelControl` seat matches the native trailing model position,
so a Bridge model selector can be injected once the protocol capability is ready.
Running sessions also use the native primary action as Stop while the draft is
empty, and return to Send as soon as the user types. `ComposerSurface` remains the
lower-level public card primitive.

The browser calls the same-origin `/agent-control` Host RPC channel. It never
receives the Bridge origin, bearer token, Hermes filesystem paths, or sidecar
environment. Assistant prose uses DSH's untrusted Markdown renderer (raw HTML and
unsafe link protocols are disabled); raw events and other external output remain
React text. Markdown may display absolute HTTP(S) images according to DSH policy.

## Install

Build the checkout and add it to a DSH Web profile:

```sh
pnpm install
pnpm check
dsh plugin --profile agent-control add file:/root/agent-bridge/integrations/dsh-agent-control
dsh --profile agent-control --dump-config
dsh --profile agent-control web
```

For a source DSH checkout, replace `dsh` with `pnpm --dir
/root/deepseek-harness-research dsh`. `dsh plugin add` reads `dsh.bundle` from
`package.json` and adds the single row in `cordis.patch.yml`; the package's
`dsh.client` manifest makes the same row discover its browser face.

The checked-in bundle defaults target Hal. Override the row in the profile's
`cordis.patch.yml` for another installation. A patch replaces the complete
config, so restate both `bridge` and `kanban` objects.

## Configuration

```yaml
- id: agent-control
  config:
    bridge:
      mode: live                 # live | mock
      origin: http://127.0.0.1:8787
      tokenEnv: AGENT_BRIDGE_CONTROL_TOKEN
      timeoutMs: 15000
    kanban:
      mode: sidecar              # sidecar | http | mock
      board: default
      hermesRoot: /root/.hermes/hermes-agent
      hermesHome: /root/.hermes
      python: python3
      permissionMode: orchestrator # read-only | orchestrator | operator
      author: dsh-orchestrator
      timeoutMs: 15000
```

`bridge.token` is also supported as a secret schema field, but an environment
variable is preferred. Never put it in a browser-facing environment variable.
All new Bridge writes receive a UUID `Idempotency-Key` and UI submit controls
stay disabled until the request settles.

Kanban modes:

- `sidecar` (default) spawns `python/kanban_adapter.py` directly, sends bounded
  JSON-lines messages, and imports Hermes `kanban_db`/`kanban_db_connect`. It
  does not execute CLI text and does not reimplement the lifecycle state machine.
- `http` uses the existing Hermes dashboard plugin API. Set `baseUrl` to the
  mounted `/api/plugins/kanban/` URL and optionally `tokenEnv`. The current
  dashboard has no request-changes endpoint, so that operation deliberately
  reports `kanban_http_unsupported`; sidecar mode supports it through the real
  domain function.
- `mock` uses deterministic workers/sessions/pending/task fixtures and is safe
  for UI development without either backend.

Permission modes are enforced before a transport call:

- `read-only`: queries only.
- `orchestrator`: create, comment, dependency link, request review/changes.
- `operator`: also unblock, reassign, and reclaim.

Worker-only Hermes operations (`claim`, `heartbeat`, `complete`, and `block`) and
all delete/archive operations are absent from the service and model tool roster.
Every model-facing mutation additionally returns DSH's native `ask` decision in
`tools/pre-execute`, so the configured approval channel remains authoritative.

## Mock profile

Use a profile override for a completely local UI/load smoke:

```yaml
- id: agent-control
  config:
    bridge:
      mode: mock
      origin: http://unused.invalid
      tokenEnv: UNUSED
      timeoutMs: 1000
    kanban:
      mode: mock
      board: test
      hermesRoot: /unused
      hermesHome: /unused
      python: python3
      permissionMode: read-only
      author: dsh-test
      timeoutMs: 1000
```

## Development and verification

For a local mock-only browser preview of the **built client bundle**:

```sh
pnpm --filter dsh-agent-control-plugin preview:mock
```

This builds the plugin and opens
`http://127.0.0.1:4178/fixtures/session-preview.html`. Click Agent Control, then
Sessions. The preview uses a small slot/static-module harness with real React and
the published DSH primitives; it is not a full DSH Host/profile integration test.
Its Host dispatch is hard-coded to mock Bridge/Kanban transports and binds only
to loopback. It does not read credentials, use a live Bridge, or modify the user's board.
The active-session fixture has 202 events so history continuation can be exercised.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The test suite verifies Bridge header/idempotency behavior, token non-disclosure,
runtime tool schemas, Cordis registration/disposal, permission gates, UI entry
state, mock overview aggregation, and real Hermes create/list/show/comment calls
against a newly created temporary `HERMES_HOME`. It never opens or mutates the
user's board.

The Bridge live smoke requires the parallel Control Plane implementation to be
running with the configured token. Verify at least:

```sh
curl -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" http://127.0.0.1:8787/api/v1/workers
curl -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" http://127.0.0.1:8787/api/v1/snapshot
```

Then open Agent Control and check Sessions. If the deployed Bridge still only
implements legacy workers/runs, `/workers` succeeds while `/snapshot` and
`/sessions` correctly surface backend errors; the plugin does not invent data
or silently claim integration success.

## Architecture notes

- Agent Bridge remains the source of truth for external sessions.
- Hermes remains the source of truth for task lifecycle.
- DSH Sessions retain only DSH conversation history; this plugin does not copy
  external threads into the DSH session store.
- Task/session association is displayed when the Bridge projection supplies
  `taskId`/`runId`; it never advances a Kanban card.
- Lists load through `/sessions` pagination, independently of the overview's
  bounded snapshot. Search and counts describe loaded rows; load more to widen
  the search. Refresh refills the number of rows already loaded.
- History starts at the oldest retained event and exposes forward continuation.
  Once caught up, visible Sessions poll the selected session/pending requests
  and new events every five seconds. Incomplete history does not auto-drain in
  the background. A cursor error retains the displayed data and offers a baseline reload.
- Mutations require the worker's `session-actions` capability. Accepted actions
  remain pending until their receipt is checked; failed sends retain the draft.
  Session drafts/history/receipts survive tab switches and closing/reopening the overlay
  for the lifetime of the mounted plugin. They are not persisted across page reloads.
- Host SSE, unified native/external navigation, persistent view preferences,
  full-text search, and native Chat/Workspace browser extraction remain future work.

## Repository layout

Round 5 uses DSH's published Button component in the workspace and reader controls,
alongside the existing MarkdownText and TerminalBlock. The integrated reader follows
the `--dsw-alias-*`, `--dsh-content-font-size`, and conversation-width axes. Assistant
content is an unboxed reading flow; the composer shares its alignment. Turn ids remain
available in Raw events. This shares primitives and theme/font axes, not the complete
native Chat layout implementation.

Project headings offer `+` to create an empty conversation in that exact worker and
directory; the detail header has the same action for pinned/flat views. Worker status
and `session-actions` gate creation. Accepted receipts are polled, duplicate clicks
are suppressed, and only confirmed success selects the new session. If the user has
selected another session meanwhile, the receipt offers Open conversation instead.
Live creation uses the existing Host RPC; no initial agent message is sent.

View options now defaults to Newest created, with Recently updated as an alternative.
Groups follow their newest matching loaded row. Equal update timestamps break by
creation time. Sorting is limited to loaded rows: the deployed Host still fetches
pages in server update order. The backend currently changes updatedAt when a worker
goes offline; a future activity timestamp and server-side sort plumbing are required
for authoritative global last-conversation-activity ordering.

Round 4 replaces the footer's five-row shortcut list with a DSH / Bridge source
switch. Bridge mode temporarily shadows `sidebar.workspaces` and `conversation`
using the published slot priority/disposal contract. The full browser and reader
share one store in the normal shell columns; returning to DSH removes both
registrations and restores native occupants. Native selection changes also exit
Bridge mode. Entering Bridge closes the native details panel. Agent Control's
overview and Kanban remain an overlay; its Sessions navigation opens Bridge mode.

The footer preloads the first session page on mount without loading transcripts.
Reopening Bridge reuses the in-memory list; refresh remains explicit. This does
not provide a persistent offline list cache or merge native and external rows in
one tree. Advanced list controls live under View options to preserve vertical space.

Session UI rounds 2–3 add a `Bridge sessions` section in DSH's sidebar footer,
sharing the overlay's session store. It opens recent or pinned loaded sessions
directly. Pins, grouping, collapsed groups, and event-anchored reading positions
persist in origin-local storage; transcript text, drafts, and credentials do not.
Preferences are scoped to the browser origin, not to a Bridge backend identity.
The reader offers first/latest loaded jumps and renders terminal-only summaries
as Markdown by default. Bulk collapse/expand operates on visible groups; Locate
current clears search and attention filters, reveals the selected group, and
scrolls the list to its row. Search and counts cover loaded sessions only.

These remain additive sidebar shortcuts and a plugin overlay, not registration
in DSH's native session tree. Pinned sessions must be loaded to appear. Reading
positions in later history pages restore when those pages are loaded manually.


- `src/index.ts`: Host plugin, schema, route, prompt, and approval policy.
- `src/bridge-client.ts`: Agent Control v1 client and mock transport.
- `src/kanban-client.ts`: permission gate and Kanban transports.
- `src/tools.ts`: model-facing DSH tool definitions.
- `src/client/`: DSH Client Module closure and Slots workspace.
- `python/kanban_adapter.py`: controlled Hermes domain adapter.
- `fixtures/`: stable mock fixture samples.
- `tests/`: unit, lifecycle, client, security, and isolated integration checks.

## Non-goals

This package does not publish to npm, deploy production services, modify DSH or
Hermes source, delete sessions/tasks/files/databases, or treat agent prose as
completion proof.
