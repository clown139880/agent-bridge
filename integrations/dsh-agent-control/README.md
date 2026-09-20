# DSH Agent Control Plugin

An installable, out-of-tree DeepSeek Harness bundle that adds an Agent Bridge
control surface and a Hermes Kanban workspace without patching DSH itself.

The production target is the DSH `0.1.3-alpha.1` runtime bundled with
TokensCowork. Most development dependencies are pinned to the published
`0.1.2-rc.1` packages (with selected alpha packages where available), Cordis
`4.0.2`, Node `^22.19.0 || >=24`, and pnpm `11.7.0`. Because the development
packages are not identical to the installed runtime, typecheck/build success is
not runtime compatibility proof; the installed-runtime verifier is required.

## What it provides

- Bridge conversations automatically join the existing native DSH Sessions tree.
- Stable identities, paginated retained-history projection, workspace grouping,
  persistence/resume and incremental reconciliation.
- Native conversation/composer backed by the agent-bridge execution provider;
  remote tool activities are displayed without executing them locally.
- Native pending approvals/questions, guarded turn submission and interruption.
- Additive Agent Control / Hermes Kanban management overlays and model tools.

Bridge remains authoritative for remote execution. DSH owns its presentation
projection; there is no second session browser or composer. Initial history
hydration is eager and bounded to four concurrent jobs. Bridge conversations
reuse DSH's native model-control UI but load the catalog from their bound worker;
the selected model and reasoning effort are sent explicitly on the next new turn.
Native DSH conversations retain the ordinary shared-provider catalog. Images use native attachment storage and
Bridge uploads. Directory creation offers local DSH and machine-specific Bridge
sources. Workspaces with the same normalized repository identity are merged in
the native catalog across workers and machines without rewriting stored session
identities or execution bindings.

See [the session-provider design](docs/bridge-conversation-provider.md) for the
data path, runtime contracts, deployment checks and current limits.
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

### Upgrading retained Bridge history to Session V3

DSH Session V3 deliberately refuses unclassified V2 events. Agent Bridge V2
logs contain audited `agent-bridge/binding` and `agent-bridge/event` records, so
run the compatibility migration once after upgrading DSH and before reopening
those conversations. Stop TokensCowork first, preview every candidate, and then
publish immutable V3 successors:

```powershell
node scripts/migrate-v2-history.cjs
node scripts/migrate-v2-history.cjs --apply
```

The migration never changes or deletes `session.v2.jsonl[.zstd]`. It validates
the Bridge event payloads, applies DSH V3 system-message promotion and sequence
reference remapping, and creates `session.v3.jsonl[.zstd]` only when no V3
artifact already exists. An unfamiliar event or seeded log is rejected without
publishing a successor.

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
delete/archive operations remain absent from the model tool roster. Explicit desktop UI deletion is supported through the trusted Host RPC.
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
runtime tool schemas, Cordis registration/disposal, permission gates, provider
projection and reconciliation, source selection, native catalog merging,
session-menu deletion, and real Hermes calls against a newly created temporary
`HERMES_HOME`. It never opens or mutates the user's board.

The Bridge live smoke requires the Control Plane implementation to be running
with the configured token. Verify at least:

```sh
curl -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" http://127.0.0.1:8787/api/v1/workers
curl -H "Authorization: Bearer $AGENT_BRIDGE_CONTROL_TOKEN" http://127.0.0.1:8787/api/v1/snapshot
```

Then check the provider status in Agent Control and open DSH's original Sessions
tree. Bridge conversations should appear there automatically; there is no import
step, source switch, replacement browser, or replacement composer. If the deployed Bridge still only
implements legacy workers/runs, `/workers` succeeds while `/snapshot` and
`/sessions` correctly surface backend errors; the plugin does not invent data
or silently claim integration success.

## Architecture notes

The [Bridge conversation provider](docs/bridge-conversation-provider.md) is the
current design. The earlier session-hub evaluation and UI-shadow implementation
are historical. Bridge remains authoritative for remote sessions; DSH stores a
native presentation projection and uses its original tree and conversation.

Hermes remains authoritative for task lifecycle. Session/task links do not
advance cards automatically. Host-only credentials stay in the Bridge client.

## Repository layout

- src/index.ts: Host plugin, schema, RPC, prompt and approval policy.
- src/agent-bridge-provider/: catalog synchronization, native projection and execution.
- src/bridge-client.ts: Agent Control v1 client and mock transport.
- src/kanban-client.ts: permission gate and Kanban transports.
- src/tools.ts: model-facing DSH tool definitions.
- src/client/: additive Agent Control / Kanban overlay.
- python/kanban_adapter.py: controlled Hermes domain adapter.
- fixtures/: development-only management overlay preview.

### Session menu deletion

The native sidebar ellipsis menu now contains **删除会话** alongside rename, fork,
and archive. It targets the clicked row, even if another session is selected.
Bridge sessions use confirmed Control Plane deletion. Local DSH sessions use
logical deletion: a durable marker and native archive remove the conversation
from the list; original logs are retained for recovery and fork lineage. Project
files are never removed. Running sessions and pending approval/input must settle
before deletion.

The client compatibility adapter wraps the existing `sidebar.workspaces` slot
component and recognizes the native rename/fork/archive menu by its item IDs.
It preserves the original slot identity, store, locale, callbacks, and directory
picker. Unloading restores the original component. Tests exercise the published
DSH row implementation; changes to that upstream contract need revalidation.
