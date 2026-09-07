# DSH Agent Control Plugin

An installable, out-of-tree DeepSeek Harness bundle that adds an Agent Bridge
control surface and a Hermes Kanban workspace without patching DSH itself.

Compatibility is pinned and tested against the published DSH developer preview
`0.1.2-rc.1`, Cordis `4.0.2`, Node `^22.19.0 || >=24`, and pnpm `11.7.0`.

## What it provides

- A Sidebar **Agent Control** entry that opens an additive `shell.overlay` workspace.
- Overview, external Sessions, and Hermes Tasks views while the native DSH conversation remains mounted.
- Session timeline, auto steer/start submission with `expectedTurnId`, interruption,
  approvals, structured input discovery, task creation/details/comments/runs, and real assignee selection.
- 24 registered model tools covering workers/sessions/events/actions/pending requests and
  Kanban query/create/comment/dependency/review/operator operations.
- One Host-owned `AgentControlService` shared by UI requests and model tools.
- Live and mock Bridge transports, plus sidecar/HTTP/mock Kanban transports.

The browser only calls the same-origin `/api/agent-control` Host route. It never
receives the Bridge origin, bearer token, Hermes filesystem paths, or sidecar
environment. External output is rendered as React text/`pre` content; no trusted
HTML path exists.

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
- The UI currently polls explicitly on open/refresh and after mutations. A
  future version can add one Host-owned SSE cache without changing the service,
  tool, or component boundary.

## Repository layout

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
