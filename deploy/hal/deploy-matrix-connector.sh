#!/usr/bin/env bash
# Deploy only the Matrix connector on HAL: fast-forward to origin/main, build it and
# restart its own unit. The Control Plane and HAL Bridge are not touched, so a caller
# hosted by the HAL Bridge keeps its turn.
#
# Usage: deploy/hal/deploy-matrix-connector.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
unit=agent-matrix-connector.service
env_file=/etc/agent-bridge/matrix-connector.env
log() { echo "[matrix-connector] $*"; }
die() { echo "[matrix-connector] $*" >&2; exit 1; }

exec 9>/run/lock/agent-bridge-deploy.lock
flock -n 9 || die "another deploy is running"
cd "$repo"
[ "$(git branch --show-current)" = main ] || die "checkout is not on main"
[ -z "$(git status --porcelain)" ] || { git status --short >&2; die "checkout is dirty; refusing to deploy"; }
[ -f "$env_file" ] || die "$env_file is missing (see deploy/hal/matrix-connector.env.example)"

previous=$(git rev-parse HEAD)
git fetch --quiet origin main
git merge --ff-only --quiet origin/main
if [ ! -d node_modules ] || ! git diff --quiet "$previous" HEAD -- pnpm-lock.yaml; then
  CI=true pnpm install --frozen-lockfile --filter '!dsh-agent-control-plugin'
fi
pnpm --filter @agent-bridge/matrix-connector build || die "build failed; the running connector is unchanged"

if ! cmp -s "deploy/systemd/$unit" "/etc/systemd/system/$unit"; then
  install -m 0644 "deploy/systemd/$unit" "/etc/systemd/system/$unit"
  systemctl daemon-reload
  systemctl enable --quiet "$unit"
  log "installed $unit"
fi
systemctl restart "$unit"
sleep 3
systemctl is-active --quiet "$unit" || { journalctl -u "$unit" -n 20 --no-pager >&2; die "$unit did not stay up"; }
log "running $(node -p 'require("./apps/matrix-connector/package.json").version') ($(git rev-parse --short HEAD))"
