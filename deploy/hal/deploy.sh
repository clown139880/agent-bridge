#!/usr/bin/env bash
# Deploy the HAL Control Plane and Bridge from this checkout: fast-forward to
# origin/main, compile, and restart both services.
#
# Any agent may run this unattended, including one hosted by the Bridge it is about
# to restart: every step before the restart is non-disruptive, and the restart is
# queued in systemd (--no-block), so it completes even though it ends the caller's
# session. Once up, the Control Plane sends its control_plane.up webhook (relayed to
# the notification room) and advertises its version to the rest of the fleet.
#
# Usage: deploy/hal/deploy.sh [--force]   (--force restarts even when up to date)
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
branch=main
units=(agent-control-plane.service agent-bridge-hal.service)
marker=${AGENT_BRIDGE_DEPLOYED_MARKER:-/var/lib/agent-bridge/deployed-commit}
health_url=${AGENT_BRIDGE_HEALTH_URL:-http://127.0.0.1:8787/health}
# Drop-in left by the retired release-symlink deploy; it pins the Bridge to /opt.
legacy_dropins=(/etc/systemd/system/agent-bridge-hal.service.d/release.conf)
force=false
[ "${1:-}" = "--force" ] && force=true

log() { echo "[deploy] $*"; }
die() { echo "[deploy] $*" >&2; exit 1; }

exec 9>/run/lock/agent-bridge-deploy.lock
flock -n 9 || die "another deploy is running"

cd "$repo"
[ "$(git branch --show-current)" = "$branch" ] || die "checkout is not on $branch"
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  die "checkout is dirty; refusing to deploy"
fi

previous=$(git rev-parse HEAD)
git fetch --quiet origin "$branch"
git merge --ff-only --quiet "origin/$branch"
target=$(git rev-parse HEAD)
if ! "$force" && [ "$(cat "$marker" 2>/dev/null)" = "$target" ]; then
  log "already running $target"
  exit 0
fi

# Only the services are installed and compiled; the DSH plugin is not used on HAL.
build() {
  if [ ! -d node_modules ] || ! git diff --quiet "$1" "$2" -- pnpm-lock.yaml; then
    CI=true pnpm install --frozen-lockfile --filter '!dsh-agent-control-plugin'
  fi
  pnpm exec tsc -b --pretty false
}

if ! build "$previous" "$target"; then
  log "build of $target failed; restoring $previous"
  git reset --hard --quiet "$previous"
  build "$target" "$previous" || log "rebuild of $previous failed too"
  die "deploy aborted; services were not restarted"
fi

reload=false
for unit in "${units[@]}"; do
  cmp -s "deploy/systemd/$unit" "/etc/systemd/system/$unit" && continue
  install -m 0644 "deploy/systemd/$unit" "/etc/systemd/system/$unit"
  log "installed $unit"
  reload=true
done
for dropin in "${legacy_dropins[@]}"; do
  [ -e "$dropin" ] || continue
  rm -f "$dropin"
  log "removed $dropin"
  reload=true
done
"$reload" && systemctl daemon-reload

version=$(node -p 'require("./package.json").version')
mkdir -p "$(dirname "$marker")"
echo "$target" > "$marker"
log "restarting ${units[*]} for $version ($target)"
systemctl restart --no-block "${units[@]}"

# A caller hosted by the Bridge is terminated by that restart; anyone else waits
# for the services to come back and reports the outcome.
grep -q "/agent-bridge-hal.service" /proc/self/cgroup && exit 0
for _ in $(seq 1 30); do
  sleep 2
  if systemctl is-active --quiet "${units[@]}" && curl -fsS --max-time 2 "$health_url" >/dev/null 2>&1; then
    log "deployed $version ($target)"
    exit 0
  fi
done
systemctl --no-pager --lines=20 status "${units[@]}" >&2 || true
die "services did not become healthy within 60s"
