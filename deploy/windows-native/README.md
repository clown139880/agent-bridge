# Windows DSH Agent Control plugin — update runbook

Agent-operable steps to update the **DSH Agent Control plugin** inside the
Windows desktop client. Read `AGENTS.md` (“DSH Agent Control plugin deployment”)
first — its rules win over convenience.

## TL;DR — update from WSL (the method actually used day to day)

From the repo in WSL:

```bash
deploy/windows-native/install-plugin-from-wsl.sh          # build + install + restart TokensCowork
NO_RESTART=1 deploy/windows-native/install-plugin-from-wsl.sh   # build + install only
```

It builds the plugin (`CI=true` so pnpm 11 doesn't abort the non-TTY modules
purge), copies the bundle into the Windows profile plugin dir, verifies the
installed files hash-match the source, and restarts the client. This works
because WSL reaches the Windows filesystem at `/mnt/c` and drives Windows via
`powershell.exe`; the bundle is pure JS built deterministically from the
committed source, so a WSL build == a Windows build (hash-verified). The plugin
must already be registered in the profile once (`dsh plugin add`, see below);
after that this script is all you need. Methods A/B below are the manual
equivalents and the background.

## The setup on this machine

- **Client:** `TokensCowork` (Electron, DeepSeek Harness build), launched from
  `C:\Users\clown\AppData\Local\Programs\TokensCowork\TokensCowork.exe`.
  It serves a local HTTP port (e.g. `43120`) discovered from its listening sockets.
- **Profile:** `desktop`, config under `C:\Users\clown\.dsh\profiles\desktop`.
  - Plugin is loaded from `…\profiles\desktop\node_modules\dsh-agent-control-plugin\lib\`
    (confirmed by the boot error trace). This directory is the install target.
  - `cordis.patch.yml` holds the `agent-control` config: `bridge.origin`
    (`http://192.168.5.44:8787` = HAL control-plane) and `tokenEnv: AGENT_BRIDGE_CONTROL_TOKEN`.
- **Token:** `AGENT_BRIDGE_CONTROL_TOKEN` must be set as a **Windows User env var**
  (the Electron app inherits it at launch). It must equal HAL’s
  `CONTROL_API_WRITE_TOKEN` (the plugin creates sessions and resolves approvals).
  Verify: `[Environment]::GetEnvironmentVariable('AGENT_BRIDGE_CONTROL_TOKEN','User')`.
- **Checkout on Windows:** `C:\Users\clown\Workspace\agent-bridge`.

## Preflight

```powershell
# Windows -> HAL control-plane reachable and token accepted (expect HTTP 200)
$t = [Environment]::GetEnvironmentVariable('AGENT_BRIDGE_CONTROL_TOKEN','User')
Invoke-WebRequest -Uri 'http://192.168.5.44:8787/api/v1/workers' -Headers @{Authorization="Bearer $t"} -UseBasicParsing
```

## Method A — sanctioned (build on the target, `git pull --ff-only`)

Deployments should start from a **pushed commit** and a clean pull (AGENTS.md).

1. Update the Windows checkout to the pushed commit:
   ```powershell
   git -C C:\Users\clown\Workspace\agent-bridge pull --ff-only origin main
   ```
   If this fails with “local changes would be overwritten” but the diff is only
   line endings, it is **CRLF noise** (the repo has no `.gitattributes`). Confirm
   with `git -c core.autocrlf=false diff --ignore-all-space --stat`; only a file
   with real content changes matters. Resolve the phantom modifications (e.g.
   `git -c core.autocrlf=false checkout -- <eol-only paths>`) — never blindly
   discard a file that has a *real* diff (e.g. someone’s edited `.ps1`).
2. Build the plugin:
   ```powershell
   pnpm --filter dsh-agent-control-plugin build   # via Windows pnpm
   ```
3. Install into the profile + verify hashes with the shipped script. The client
   uses **Restricted** execution policy by default, so run it with a
   process-scoped `RemoteSigned` (NOT `-ExecutionPolicy Bypass`, which weakens
   endpoint security and is denied):
   ```powershell
   powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
     C:\Users\clown\Workspace\agent-bridge\deploy\windows-native\update-dsh-client.ps1
   ```
   `update-dsh-client.ps1` auto-detects the running client’s origin, atomically
   replaces `index.js{,.map}`, `client.js{,.map}` + `package.json`, and verifies
   installed (and, on unauthenticated servers, served) hashes.

## Method B — fallback (build on a clean checkout, copy the bundle)

Use only when Method A is blocked (dirty CRLF tree that can’t be cleaned in
place, or the script can’t run). The bundle is **pure JS and deterministic from
the commit**, so building on any clean checkout at the same pushed commit yields
byte-identical output (verify by hash). This still deploys a pushed commit — it
does **not** deploy uncommitted source.

```bash
# On a clean checkout at the target commit (e.g. WSL):
pnpm --filter dsh-agent-control-plugin build
SRC=<clean-checkout>/integrations/dsh-agent-control
DST=/mnt/c/Users/clown/.dsh/profiles/desktop/node_modules/dsh-agent-control-plugin
for f in index.js index.js.map client.js client.js.map; do cp -f "$SRC/lib/$f" "$DST/lib/$f"; done
cp -f "$SRC/package.json" "$DST/package.json"
# Verify installed == source:
for f in index.js client.js; do
  [ "$(sha256sum "$SRC/lib/$f"|cut -d' ' -f1)" = "$(sha256sum "$DST/lib/$f"|cut -d' ' -f1)" ] && echo "$f OK" || echo "$f MISMATCH"
done
```

No backups are kept — overwrite in place.

## Activation / restart

- **Default: do NOT restart TokensCowork for a plugin update** (AGENTS.md): a
  restart can terminate an in-flight plugin method call. Renderer bundles are
  picked up on reload; Host-side changes may need a restart.
- **Only restart when the operator explicitly asks**, or a Host-side change
  requires it. To restart from WSL:
  ```bash
  powershell.exe -NoProfile -Command "Get-Process TokensCowork -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 3; Start-Process 'C:\Users\clown\AppData\Local\Programs\TokensCowork\TokensCowork.exe'"
  ```
  A freshly launched process inherits the current `AGENT_BRIDGE_CONTROL_TOKEN`
  User env var; a process started before the var was set will not have it.

## Verify

```bash
# Installed bundle is the intended build:
sha256sum /mnt/c/Users/clown/.dsh/profiles/desktop/node_modules/dsh-agent-control-plugin/lib/client.js
```
```powershell
# Client is up and serving (port from its listening sockets). Recent builds
# serve browser plugins via a combined bundle, so the legacy per-plugin URL
# /plugins/dsh-agent-control-plugin/client.js returning 404 is expected; the
# root then requires auth (401/403).
$pids = (Get-Process TokensCowork).Id
Get-NetTCPConnection -State Listen | ? { $_.OwningProcess -in $pids } | Select LocalPort -Unique
```
Then confirm in the client UI: the Agent Bridge panel loads, lists workers
(incl. `claude@…`), and can create a Claude conversation / resolve approvals.
