#!/usr/bin/env bash
set -euo pipefail

# Sync the compiled dsh-agent-control plugin into the local DSH profile and
# restart the DSH web service. Linux/HAL analogue of
# deploy/windows-native/update-dsh-client.ps1.
#
# This performs a LOCAL, same-machine plugin install: it copies the built
# bundle (lib/), manifest, patch, and static asset dirs from this repo into the
# installed profile plugin, backs up what it replaces, verifies hashes, and
# restarts the DSH web service so a host-side (lib/index.js) change takes
# effect. It only ever touches the DSH web service (dsh-agent-control.service),
# never the HAL Bridge or Control Plane.
#
# Usage:
#   deploy/hal/sync-dsh-agent-control.sh [--build] [--no-restart] [--dry-run]
#
#   --build       run `pnpm build` in the plugin package before syncing
#   --no-restart  copy files but do not restart the service (client-only change,
#                 which browsers pick up on refresh)
#   --dry-run     print what would happen; touch nothing
#
# Env overrides:
#   DSH_PROFILE_DIR   default /root/.dsh/profiles/agent-control
#   DSH_SERVICE       default dsh-agent-control.service
#   DSH_TRUSTED_HOST  default dsh.uniclown.com (Host header for the /api probe)
#   DSH_PORT          default 8790

profile_dir=${DSH_PROFILE_DIR:-/root/.dsh/profiles/agent-control}
service=${DSH_SERVICE:-dsh-agent-control.service}
trusted_host=${DSH_TRUSTED_HOST:-dsh.uniclown.com}
port=${DSH_PORT:-8790}

do_build=0
do_restart=1
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --build) do_build=1 ;;
    --no-restart) do_restart=0 ;;
    --dry-run) dry_run=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
src="$repo_root/integrations/dsh-agent-control"
installed="$profile_dir/node_modules/dsh-agent-control-plugin"

log() { printf '[sync-dsh] %s\n' "$*"; }
die() { printf '[sync-dsh] ERROR: %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
test -d "$src" || die "plugin source not found: $src"
test -f "$src/package.json" || die "plugin manifest missing: $src/package.json"
src_name=$(node -e "process.stdout.write(require('$src/package.json').name)")
[ "$src_name" = "dsh-agent-control-plugin" ] || die "unexpected source package name: $src_name"

if [ "$do_build" = 1 ]; then
  log "building plugin (pnpm build) ..."
  [ "$dry_run" = 1 ] || ( cd "$src" && pnpm build )
fi

for f in lib/index.js lib/client.js package.json cordis.patch.yml; do
  test -f "$src/$f" || die "build output missing: $src/$f (run with --build?)"
done

test -d "$installed" || die "installed plugin not found: $installed (profile not provisioned)"
inst_name=$(node -e "process.stdout.write(require('$installed/package.json').name)")
[ "$inst_name" = "dsh-agent-control-plugin" ] || die "installed target is not the plugin: $inst_name"

if [ "$do_restart" = 1 ]; then
  systemctl cat "$service" >/dev/null 2>&1 || die "service unit not found: $service"
  # Safety fence: this script must never restart the Bridge or Control Plane.
  case "$service" in
    *bridge*|*control-plane*|agent-control-plane.service)
      die "refusing to operate on Bridge/Control-Plane unit: $service" ;;
  esac
fi

# Warn (do not block) on a dirty tree: dev iteration syncs the working tree, but
# the audited path is to sync from a pushed commit.
if git -C "$repo_root" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C "$repo_root" status --porcelain -- integrations/dsh-agent-control 2>/dev/null)" ]; then
    log "NOTE: working tree under integrations/dsh-agent-control is dirty; syncing uncommitted build."
  fi
fi

# --- dependency drift check --------------------------------------------------
# If the source manifest declares a runtime dependency that does not resolve
# from the installed plugin, the sync would install a broken plugin. Detect and
# stop with the exact command to add it into the profile.
missing_deps=$(node - "$src/package.json" "$installed" <<'NODE'
const fs = require('fs');
const [manifestPath, installedDir] = process.argv.slice(2);
const deps = Object.keys(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dependencies || {});
const { createRequire } = require('module');
const req = createRequire(installedDir + '/package.json');
const missing = [];
for (const d of deps) {
  try { req.resolve(d); } catch { missing.push(d); }
}
process.stdout.write(missing.join(' '));
NODE
)
if [ -n "$missing_deps" ]; then
  log "WARNING: source declares deps not resolvable from the installed plugin: $missing_deps"
  log "         install them into the profile before/after sync, e.g.:"
  log "           cd $profile_dir && pnpm add -w $missing_deps"
  log "         (continuing: package.json is being updated so the versions are recorded)"
fi

# --- backup ------------------------------------------------------------------
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="$profile_dir/deploy-backups/agent-control/$stamp"
log "source:    $src"
log "installed: $installed"
log "backup:    $backup_dir"
if [ "$dry_run" = 1 ]; then
  log "[dry-run] would back up lib/ package.json cordis.patch.yml, rsync, and restart=$do_restart"
  exit 0
fi
mkdir -p "$backup_dir"
cp -a "$installed/lib" "$backup_dir/lib"
cp -a "$installed/package.json" "$backup_dir/package.json"
cp -a "$installed/cordis.patch.yml" "$backup_dir/cordis.patch.yml" 2>/dev/null || true

# --- sync --------------------------------------------------------------------
# Mirror the npm `files` allowlist. Per-path rsync leaves the installed plugin's
# own nested node_modules/ untouched. --delete inside lib/ removes stale artifacts.
rsync -a --delete "$src/lib/" "$installed/lib/"
for p in python presets fixtures; do
  if [ -d "$src/$p" ]; then rsync -a --delete "$src/$p/" "$installed/$p/"; fi
done
# rsync (temp+rename) is used instead of cp so a hardlinked install is replaced
# with a fresh inode rather than erroring on same-file.
for f in package.json cordis.patch.yml README.md LICENSE; do
  if [ -f "$src/$f" ]; then rsync -a "$src/$f" "$installed/$f"; fi
done

# --- verify installed hashes -------------------------------------------------
for f in lib/index.js lib/client.js package.json cordis.patch.yml; do
  sh=$(sha256sum "$src/$f" | cut -d' ' -f1)
  ih=$(sha256sum "$installed/$f" | cut -d' ' -f1)
  [ "$sh" = "$ih" ] || die "hash mismatch after copy: $f (backup at $backup_dir)"
done
log "installed bundle hashes verified"

# --- restart + verify service ------------------------------------------------
if [ "$do_restart" = 1 ]; then
  log "restarting $service ..."
  systemctl restart "$service"
  sleep 2
  active=$(systemctl is-active "$service" || true)
  [ "$active" = "active" ] || die "$service is not active after restart (state: $active)"
  code=""
  for _ in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $trusted_host" "http://127.0.0.1:$port/api" || true)
    case "$code" in 401|200|403) break ;; esac
    sleep 1
  done
  case "$code" in
    401|200|403) log "service healthy: /api HTTP $code" ;;
    *) die "service did not serve /api after restart (last code: ${code:-none}); backup at $backup_dir" ;;
  esac
else
  log "skipped restart (--no-restart); client changes apply on browser refresh, host changes need a restart"
fi

log "DONE. client bundle sha256: $(sha256sum "$installed/lib/client.js" | cut -d' ' -f1)"
log "      host   bundle sha256: $(sha256sum "$installed/lib/index.js" | cut -d' ' -f1)"
