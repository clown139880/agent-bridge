#!/usr/bin/env bash
set -euo pipefail

env_file=${AGENT_BRIDGE_ENV_FILE:-/etc/agent-bridge/bridge.env}
if test -r "$env_file"; then
  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
fi

repo=${AGENT_BRIDGE_REPO:-/root/agent-bridge}
install_root=${AGENT_BRIDGE_INSTALL_ROOT:-/opt/agent-bridge}
service=${AGENT_BRIDGE_SERVICE:-agent-bridge-hal.service}
machine_id=${AGENT_BRIDGE_MACHINE_ID:-hal}
database=${AGENT_BRIDGE_DATABASE:-/root/agent-bridge/data/control-plane.sqlite}
drain_file=${AGENT_BRIDGE_DRAIN_FILE:-/run/agent-bridge-${machine_id}.drain}
lock_file=${AGENT_BRIDGE_DEPLOY_LOCK:-/run/lock/agent-bridge-hal-deploy.lock}
store_dir=${AGENT_BRIDGE_STORE_DIR:-$install_root/pnpm-store}
retention=${AGENT_BRIDGE_RELEASE_RETENTION:-2}
notify_after=${AGENT_BRIDGE_DEPLOY_NOTIFY_AFTER:-120}
force_after=${AGENT_BRIDGE_DEPLOY_FORCE_AFTER:-240}
poll_interval=${AGENT_BRIDGE_DEPLOY_POLL_INTERVAL:-5}
notify_command=${AGENT_BRIDGE_DEPLOY_NOTIFY_COMMAND:-}
control_api_url=${AGENT_BRIDGE_CONTROL_API_URL:-http://127.0.0.1:8787}
control_api_token=${AGENT_BRIDGE_CONTROL_API_TOKEN:-${CONTROL_API_WRITE_TOKEN:-}}
[[ "$retention" =~ ^[1-9][0-9]*$ ]] || { echo "AGENT_BRIDGE_RELEASE_RETENTION must be a positive integer." >&2; exit 1; }
[[ "$notify_after" =~ ^[1-9][0-9]*$ && "$force_after" =~ ^[1-9][0-9]*$ && "$force_after" -gt "$notify_after" ]] || {
  echo "AGENT_BRIDGE_DEPLOY_NOTIFY_AFTER and AGENT_BRIDGE_DEPLOY_FORCE_AFTER are invalid." >&2; exit 1;
}

exec 9>"$lock_file"
flock -n 9 || { echo "Another HAL Bridge deployment is running." >&2; exit 1; }

cd "$repo"
test -d .git || { echo "$repo is not a Git checkout." >&2; exit 1; }
if test -n "$(git status --porcelain)"; then
  echo "HAL checkout is dirty; refusing to stash, overwrite, or deploy." >&2
  git status --short >&2
  exit 1
fi

deployed_commit=$(cat "$install_root/current/.release-commit" 2>/dev/null || true)
if test -z "$deployed_commit"; then
  deployed_commit=$(git -C "$install_root/current" rev-parse HEAD 2>/dev/null || true)
fi
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
  pnpm --dir "$repo" install --frozen-lockfile --store-dir "$store_dir"
  pnpm --dir "$repo" check
  pnpm --dir "$repo" build
  mkdir -p "$release/apps/bridge"
  cp -a "$repo/apps/bridge/dist" "$release/apps/bridge/dist"
  cp -a "$repo/package.json" "$release/package.json"
  ln -s "$repo/node_modules" "$release/node_modules"
  if test -d "$repo/apps/bridge/node_modules"; then
    ln -s "$repo/apps/bridge/node_modules" "$release/apps/bridge/node_modules"
  fi
  printf '%s\n' "$target_commit" > "$release/.release-commit"
  printf '%s\n' "$version" > "$release/.release-version"
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

notify_deploy() {
  local event=$1 active=${2:-0}
  echo "HAL Bridge deployment: $event (active=$active)"
  if test -n "$notify_command"; then
    AGENT_BRIDGE_DEPLOY_EVENT="$event" AGENT_BRIDGE_DEPLOY_ACTIVE="$active" \
      AGENT_BRIDGE_DEPLOY_VERSION="$version" AGENT_BRIDGE_DEPLOY_COMMIT="$target_commit" \
      AGENT_BRIDGE_DEPLOY_MACHINE="$machine_id" "$notify_command" ||
      echo "Deployment notification command failed." >&2
  fi
}

active_count() {
  if ! test -f "$database"; then echo 0; return; fi
  sqlite3 "$database" "
    SELECT
      (SELECT COUNT(*) FROM sessions
        WHERE machine_id='$machine_id'
          AND activity_status IN ('creating','active','waiting_for_approval','waiting_for_input'))
      +
      (SELECT COUNT(*) FROM pending_requests
        WHERE machine_id='$machine_id' AND status='pending');"
}

interrupt_active_sessions() {
  test -n "$control_api_token" || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local body session_id
  body=$(curl -fsS --max-time 10 -H "Authorization: Bearer $control_api_token" \
    "$control_api_url/api/v1/sessions?machineId=$machine_id&active=true&limit=200") || return 0
  while IFS= read -r session_id; do
    test -n "$session_id" || continue
    curl -fsS --max-time 10 -o /dev/null -X POST \
      -H "Authorization: Bearer $control_api_token" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: hal-deploy-${target_commit}-${session_id}" \
      --data '{}' "$control_api_url/api/v1/sessions/$session_id/interrupt" || true
  done < <(node -e 'const x=JSON.parse(process.argv[1]); for (const s of (x.data ?? [])) if (s.sessionId) console.log(s.sessionId)' "$body" 2>/dev/null || true)
}

install -m 0644 /dev/null "$drain_file"
started_wait=$(date +%s)
notified=false
idle_observation=0
while true; do
  active=$(active_count)
  elapsed=$(( $(date +%s) - started_wait ))
  if test "$active" -eq 0; then
    idle_observation=$((idle_observation + 1))
    test "$idle_observation" -ge 2 && break
  else
    idle_observation=0
  fi
  if test "$elapsed" -ge "$notify_after" && ! "$notified"; then
    notify_deploy waiting "$active"
    notified=true
  fi
  if test "$elapsed" -ge "$force_after"; then
    notify_deploy interrupting "$active"
    interrupt_active_sessions
    break
  fi
  sleep "$poll_interval"
done

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

# Keep the active artifact and the newest previous artifacts for rollback.
mapfile -t releases < <(find "$install_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
kept=0
for candidate in "${releases[@]}"; do
  test "$candidate" = "$(readlink -f "$install_root/current")" && continue
  kept=$((kept + 1))
  if test "$kept" -ge "$retention"; then
    # Older deployments may still be Git worktrees from the pre-artifact
    # layout. Unregister them before removing their directory.
    if test -f "$candidate/.git"; then
      git -C "$repo" worktree remove --force "$candidate" 2>/dev/null || true
    fi
    rm -rf -- "$candidate"
  fi
done
