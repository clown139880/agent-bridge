# DSH web console — plugin auto-sync (HAL / Linux)

The DSH web console at `dsh.uniclown.com` runs the `dsh-agent-control-plugin`
from this repo, installed into the local DSH profile. This document describes
the repeatable mechanism that pushes a freshly compiled plugin into that
deployment.

## What runs where

- **CLI (installation scope):** `@deepseek-ai/dsh@0.1.7-rc.2` at
  `/opt/dsh-cli/0.1.7-rc.2` — supplies all shared/peer packages.
- **Profile (profile scope):** `/root/.dsh/profiles/agent-control` — booted by
  `systemd` unit `dsh-agent-control.service` on `127.0.0.1:8790`, behind the
  `cloudflared` tunnel and Cloudflare Access for `dsh.uniclown.com`.
- **Our plugin:** `integrations/dsh-agent-control` in this repo, installed into
  `…/agent-control/node_modules/dsh-agent-control-plugin`.
- Session data (`$DSH_HOME/sessions`) and workspaces (`$DSH_HOME/storages`)
  live outside the profile and survive reinstalls.

## How to update (compile → deploy)

One command, from the plugin package:

```bash
pnpm --filter dsh-agent-control-plugin sync:hal
# equivalently, from integrations/dsh-agent-control:  pnpm sync:hal
```

`sync:hal` runs `deploy/hal/sync-dsh-agent-control.sh --build`, which:

1. Builds the plugin (`pnpm build` → `lib/index.js`, `lib/client.js`, maps).
2. Checks the source `dependencies` all resolve from the installed plugin;
   warns with the exact `pnpm add -w …` command if a new external dep (e.g.
   `yaml`) is missing from the profile.
3. Backs up the currently installed `lib/`, `package.json`, `cordis.patch.yml`
   to `…/agent-control/deploy-backups/agent-control/<timestamp>/`.
4. rsyncs the npm `files` allowlist (`lib/`, `python/`, `presets/`,
   `fixtures/`, `package.json`, `cordis.patch.yml`, `README.md`, `LICENSE`)
   into the installed plugin. The profile's own root `cordis.patch.yml`
   (bridge/kanban config) and the plugin's nested `node_modules/` are left
   untouched.
5. Verifies source vs installed sha256 for the key bundles.
6. Restarts `dsh-agent-control.service` and confirms `/api` returns HTTP
   401/200/403 (401 unauthenticated = healthy behind the trusted-host fence).

To sync an already-built tree without rebuilding, or without a restart
(client-only change, applied on browser refresh):

```bash
deploy/hal/sync-dsh-agent-control.sh              # sync current lib/, restart
deploy/hal/sync-dsh-agent-control.sh --no-restart # host change needs a restart
deploy/hal/sync-dsh-agent-control.sh --dry-run    # show plan, touch nothing
```

## When / who triggers it

- **Who:** the operator/agent doing plugin work on HAL, or Hermes as part of a
  deployment. It is intentionally an explicit one-command step, not an
  unconditional post-build hook — auto-restarting production on every dev build
  (including on Windows/dev machines that have no profile) is undesirable, and
  the audited path is to sync from a pushed commit.
- **When:** after `integrations/dsh-agent-control` changes are built (and,
  for the audited path, committed and pushed). The script warns if the working
  tree is dirty but still syncs, so local iteration works.
- **Version:** plugin-only changes bump only `dsh-agent-control-plugin`'s
  version (per `AGENTS.md`), never the root package, and never trigger a Bridge
  or Control Plane deployment.

## How to verify

```bash
systemctl is-active dsh-agent-control.service           # -> active
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: dsh.uniclown.com' http://127.0.0.1:8790/api # -> 401
node -e "console.log(require('/root/.dsh/profiles/agent-control/node_modules/dsh-agent-control-plugin/package.json').version)"
curl -sI https://dsh.uniclown.com/                      # -> 302 to Cloudflare Access
```

Open `https://dsh.uniclown.com/` (through Cloudflare Access) and confirm the
workspace sessions render. The persistent web-access token URL is at
`/root/.dsh/dsh-web-access.txt`.

## Rollback

Restore the most recent backup and restart:

```bash
b=/root/.dsh/profiles/agent-control/deploy-backups/agent-control/<timestamp>
inst=/root/.dsh/profiles/agent-control/node_modules/dsh-agent-control-plugin
rsync -a --delete "$b/lib/" "$inst/lib/"
cp -a "$b/package.json" "$inst/package.json"
systemctl restart dsh-agent-control.service
```

## Safety fences

- The script refuses to operate on any unit whose name matches `*bridge*`,
  `*control-plane*`, or `agent-control-plane.service`.
- It only ever restarts the DSH web console. A Codex behind the HAL Bridge must
  never activate a HAL release or restart the HAL Bridge / Control Plane.
- It does not touch the Hermes Kanban DB or the profile's `cordis.patch.yml`.
