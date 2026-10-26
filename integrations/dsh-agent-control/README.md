# DSH Agent Control Plugin

An installable, out-of-tree DeepSeek Harness bundle that adds an Agent Bridge
control surface without patching DSH itself.

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
- Additive Agent Control management overlay and model tools.

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
receives the Bridge origin, or bearer token. Assistant prose uses DSH's untrusted Markdown renderer (raw HTML and
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
config, so restate the full `bridge` object.

### Session V4 plugin records and retained V3 history

Plugin 0.2.4 uses the V4 `appendPluginRecord` API and recognizes both legacy
`agent-bridge/*` and migrated `plugin:agent-bridge/*` metadata. New seeds mark
Bridge records `ignorable`. Older runtimes retain their legacy append behavior.

V4's fixed V3 migration vocabulary does not use the live event registry. V3
files written without `ignorable` therefore require a one-time envelope repair.
Stop Desktop and all writers, then run (substitute the active Desktop's dependencies):

```powershell
node scripts/repair-v3-plugin-records.cjs --runtime C:/path/to/desktop/node_modules
node scripts/repair-v3-plugin-records.cjs --runtime C:/path/to/desktop/node_modules --apply
node scripts/verify-v4-records.cjs C:/path/to/desktop/node_modules
```

The repair only adds `ignorable: true` to the two Bridge record types in V3
files without an existing V4 successor. It preserves every payload, sequence,
timestamp and reference. Each candidate must pass the installed V4 catalog's
strict migration validation before replacement; unrelated structural failures
are reported and left unchanged. Desktop still owns actual V4 migration and
child discovery. Original compressed bytes are backed up under
`~/.dsh/backups/bridge-v3-records`, verified by SHA256, and replaced atomically
only if the source hash is unchanged. Windows apply refuses a running Desktop.
To roll back, stop writers and restore the matching backup; retain any later
activity and V4 successor before rollback, since Desktop prefers newer formats.

For old live turns whose final Bridge answer and immediately following step/end
retain a previously closed step number, 0.2.5 adds `--repair-stale-step`.
Use `--sessions <affected-session-directory>` to preview that session first.
It corrects only that pair to the empty currently open step, requires an immediate
matching turn/end and a text-only Bridge model answer, and refuses ambiguous
cases. All other fields and event coordinates remain unchanged; the same native
validation, backup and stopped-writer requirements apply.

### Upgrading retained Bridge history to Session V3

Version 0.2.8 also provides `--repair-v4-head` for V4 histories created before
the protected system head fix. It scans histories whose first surface is not a
system message, adds an empty head and remaps references, refusing lifecycle
changes. Preview before `--apply`; stop Desktop writers before applying. This
mode backs up and atomically replaces the V4 file after native strict validation,
preserving every original message payload. The backup includes the source hash
and sequence mapping, in the same backup directory described below.

For the remaining pre-V4 structural defects, 0.2.7 provides
`repair-v3-plugin-records.cjs --runtime <Desktop/node_modules> --repair-structure`
(preview first, then add `--apply` with all writers stopped). It adds an empty
protected system head before imported messages, repairs unambiguous stale final
steps, normalizes physical turn numbering, and closes a missing turn/end only
when the prior step is already closed and the next source turn is consecutive.
Unknown events/references, forks and ambiguous overlaps are refused.

This mode publishes a **V4 successor without modifying V3**, using the installed
native codec and strict migration/current-format validation. Originals, source
hashes, changes and the V3-to-repaired sequence map are retained under
`~/.dsh/backups/bridge-v3-records` in `repair-report.json`. Original message
payloads are checked for exact equality before native V4 conversion. An existing
V4 successor is never overwritten. The Bridge writer now seeds the empty system
head on V4 so a later native turn can append its system prompt safely.

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

### Preserving live commentary in Desktop

Live Bridge replies use a separate native step for each message and tool card.
DSH renders one assistant message per step, so sharing a step hides earlier
commentary when a tool or the final answer arrives. Version 0.2.2 also translates
the native loop's cached step number after imported output advances the log.
The regression checks run the actual DSH Chat reducer while a turn runs, after
it finishes or stops, and after replay. `scripts/verify-runtime.cjs` repeats the
live/replay check against the installed Desktop runtime.

Previously stored messages are retained; this change does not rewrite older
Desktop logs that already contain several assistant messages in one step.

## Configuration

```yaml
- id: agent-control
  config:
    bridge:
      mode: live                 # live | mock
      origin: http://127.0.0.1:8787
      tokenEnv: AGENT_BRIDGE_CONTROL_TOKEN
      timeoutMs: 15000
```

`bridge.token` is also supported as a secret schema field, but an environment
variable is preferred. Never put it in a browser-facing environment variable.
All new Bridge writes receive a UUID `Idempotency-Key` and UI submit controls
stay disabled until the request settles.

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
Its Host dispatch is hard-coded to a mock Bridge transport and binds only
to loopback. It does not read credentials or use a live Bridge.
The active-session fixture has 202 events so history continuation can be exercised.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The test suite verifies Bridge header/idempotency behavior, token non-disclosure,
runtime tool schemas, Cordis registration/disposal, provider
projection and reconciliation, source selection, native catalog merging,
and session-menu deletion.

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

Desktop 0.7.6 / DSH 0.2.1-rc.2 requires a compatible peer range before it will
activate either plugin face. Release 0.2.6 declares that tested generation and
the browser bundle's explicit external modules. The native sidebar now places
**Agent 控制台** after Automations and opens its `main` panel; older shells keep
the footer overlay. Workspace, workspace-tree and flat grouping remain owned
by DSH, with Bridge catalog projection supplying merged repository membership
and activity timestamps. Installing files alone is not activation: check the
Desktop plugin manager and Host registration after upgrading.

For old commentary hidden by shared steps, see the
[read-only recovery dry run](docs/commentary-recovery.md). It validates candidates
with the installed Session and Chat code; it does not rewrite Desktop logs.

The [Bridge conversation provider](docs/bridge-conversation-provider.md) is the
current design. The earlier session-hub evaluation and UI-shadow implementation
are historical. Bridge remains authoritative for remote sessions; DSH stores a
native presentation projection and uses its original tree and conversation.

Host-only credentials stay in the Bridge client.

## Repository layout

- src/index.ts: Host plugin, schema, RPC, prompt and approval policy.
- src/agent-bridge-provider/: catalog synchronization, native projection and execution.
- src/bridge-client.ts: Agent Control v1 client and mock transport.
- src/tools.ts: model-facing DSH tool definitions.
- src/client/: additive Agent Control overlay.
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
