#!/usr/bin/env bash
set -euo pipefail

repo=${AGENT_BRIDGE_REPO:-/root/agent-bridge}
install_root=${AGENT_BRIDGE_INSTALL_ROOT:-/opt/agent-bridge}
service=${AGENT_BRIDGE_SERVICE:-agent-bridge-hal.service}
machine_id=${AGENT_BRIDGE_MACHINE_ID:-hal}
database=${AGENT_BRIDGE_DATABASE:-/root/agent-bridge/data/control-plane.sqlite}
drain_file=${AGENT_BRIDGE_DRAIN_FILE:-/run/agent-bridge-${machine_id}.drain}
drain_timeout=${AGENT_BRIDGE_DRAIN_TIMEOUT_SECONDS:-900}
lock_file=${AGENT_BRIDGE_DEPLOY_LOCK:-/run/lock/agent-bridge-hal-deploy.lock}

exec 9>"$lock_file"
flock -n 9 || { echo "Another HAL Bridge deployment is running." >&2; exit 1; }

cd "$repo"
test -d .git || { echo "$repo is not a Git checkout." >&2; exit 1; }
if test -n "$(git status --porcelain)"; then
  echo "HAL checkout is dirty; refusing to stash, overwrite, or deploy." >&2
  git status --short >&2
  exit 1
fi

deployed_commit=$(git -C "$install_root/current" rev-parse HEAD 2>/dev/null || true)
git fetch origin
git pull --ff-only origin "$(git branch --show-current)"
target_commit=$(git rev-parse HEAD)

if test "$deployed_commit" = "$target_commit"; then
  echo "HAL Bridge is already running $target_commit."
  exit 0
fi

mapfile -t changed_files < <(git diff --name-only "${deployed_commit:-$target_commit^}" "$target_commit")
plugin_only=true
for path in "${changed_files[@]}"; do
  case "$path" in
    integrations/dsh-agent-control/*) ;;
    *) plugin_only=false; break ;;
  esac
done
if "$plugin_only"; then
  echo "Changes are DSH Agent Control-only; HAL Bridge deployment is intentionally skipped."
  exit 0
fi

version=$(node -p "require('./package.json').version")
short_commit=$(git rev-parse --short=12 HEAD)
release="$install_root/releases/${version}-${short_commit}"
if ! test -d "$release"; then
  mkdir -p "$install_root/releases"
  git worktree add --detach "$release" "$target_commit"
  pnpm --dir "$release" install --frozen-lockfile
  pnpm --dir "$release" check
  pnpm --dir "$release" build
fi

previous_release=$(readlink -f "$install_root/current")
activated=false
cleanup() {
  status=$?
  if test "$status" -ne 0 && "$activated" && test -n "$previous_release"; then
    rollback_link="$install_root/.current.rollback.$$"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$install_root/current"
    systemctl restart "$service" || true
  fi
  rm -f "$drain_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

install -m 0644 /dev/null "$drain_file"
deadline=$((SECONDS + drain_timeout))
idle_observations=0
while test "$SECONDS" -lt "$deadline"; do
  active=1
  if test -f "$database"; then
    active=$(sqlite3 "$database" "
      SELECT
        (SELECT COUNT(*) FROM sessions
          WHERE machine_id='$machine_id'
            AND activity_status IN ('creating','active','waiting_for_approval','waiting_for_input'))
        +
        (SELECT COUNT(*) FROM pending_requests
          WHERE machine_id='$machine_id' AND status='pending');")
  fi
  if test "$active" -eq 0; then
    idle_observations=$((idle_observations + 1))
    test "$idle_observations" -ge 2 && break
  else
    idle_observations=0
  fi
  sleep 3
done
if test "$idle_observations" -lt 2; then
  echo "HAL Bridge did not drain within ${drain_timeout}s; release is staged but not activated." >&2
  exit 1
fi

next_link="$install_root/.current.next.$$"
ln -s "$release" "$next_link"
mv -Tf "$next_link" "$install_root/current"
activated=true
systemctl restart "$service"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$service"; then
    main_pid=$(systemctl show "$service" -p MainPID --value)
    running_dir=$(readlink -f "/proc/$main_pid/cwd" 2>/dev/null || true)
    test "$running_dir" = "$release" && break
  fi
  sleep 1
done
test "${running_dir:-}" = "$release" || {
  echo "HAL Bridge did not start from $release." >&2
  exit 1
}

activated=false
echo "HAL Bridge deployed: $version ($target_commit)"
