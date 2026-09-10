#!/usr/bin/env bash
# Build the DSH Agent Control plugin in WSL and install it into the Windows
# TokensCowork client's profile, then (optionally) restart the client.
#
# Why this exists: TokensCowork is a Windows Electron app, but the repo lives in
# WSL. WSL can reach the Windows filesystem at /mnt/c and drive Windows via
# powershell.exe, so the whole update is one command from WSL — no need for the
# Windows-side git checkout (which carries CRLF phantom diffs) or the
# execution-policy-blocked update-dsh-client.ps1.
#
# The plugin bundle is pure JS built deterministically from the committed source,
# so building in WSL and copying the bundle deploys the same bytes a Windows build
# would. Verify by hash (done below).
#
# Usage:
#   deploy/windows-native/install-plugin-from-wsl.sh            # build, install, restart
#   NO_RESTART=1 deploy/windows-native/install-plugin-from-wsl.sh   # install, don't restart
#   NO_BUILD=1  deploy/windows-native/install-plugin-from-wsl.sh    # install an already-built lib
#
# Overridable env (defaults match clown's dev-windows):
#   PROFILE_DIR   Windows DSH profile node_modules dir (the plugin lives under it)
#   CLIENT_EXE    Path to TokensCowork.exe for the restart
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO/integrations/dsh-agent-control"
PROFILE_DIR="${PROFILE_DIR:-/mnt/c/Users/clown/.dsh/profiles/desktop/node_modules/dsh-agent-control-plugin}"
CLIENT_EXE="${CLIENT_EXE:-C:\\Users\\clown\\AppData\\Local\\Programs\\TokensCowork\\TokensCowork.exe}"
ARTIFACTS=(index.js index.js.map client.js client.js.map)

[ -d "$PROFILE_DIR/lib" ] || { echo "ERROR: plugin not installed at $PROFILE_DIR (install once via 'dsh plugin add' first)"; exit 1; }

if [ -z "${NO_BUILD:-}" ]; then
  echo "== building plugin (CI=true avoids the pnpm non-TTY modules-purge abort) =="
  # CI=true is required: a version bump makes pnpm 11 think deps are stale and it
  # aborts the modules-purge prompt in a non-TTY otherwise.
  CI=true pnpm --filter dsh-agent-control-plugin build >/dev/null
fi

echo "== installing into $PROFILE_DIR =="
for f in "${ARTIFACTS[@]}"; do cp -f "$SRC/lib/$f" "$PROFILE_DIR/lib/$f"; done
cp -f "$SRC/package.json" "$PROFILE_DIR/package.json"

ok=1
for f in index.js client.js; do
  a=$(sha256sum "$SRC/lib/$f" | cut -d' ' -f1); b=$(sha256sum "$PROFILE_DIR/lib/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] && echo "  $f OK" || { echo "  $f HASH MISMATCH"; ok=0; }
done
[ "$ok" = 1 ] || { echo "ERROR: installed hashes do not match source"; exit 1; }
echo "  installed version: $(grep '"version"' "$PROFILE_DIR/package.json" | head -1 | tr -d ' ,')"

if [ -z "${NO_RESTART:-}" ]; then
  # Operator permits restarting TokensCowork for plugin iteration (see memory:
  # fleet-deployment). A renderer reload alone does not reload Host-side code.
  echo "== restarting TokensCowork =="
  powershell.exe -NoProfile -Command "Get-Process TokensCowork -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 3; Start-Process '$CLIENT_EXE'; Start-Sleep 6; Write-Output ('procs: ' + (Get-Process TokensCowork -EA SilentlyContinue).Count)" 2>&1 | tail -1
else
  echo "== skipped restart (NO_RESTART set); reopen TokensCowork to load the new bundle =="
fi
echo "done."
