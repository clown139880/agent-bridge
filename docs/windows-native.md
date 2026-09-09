# Windows-native deployment

Agent Bridge 0.5.2 supports a native Windows worker using the same Windows
Codex Desktop home. Copy `deploy/windows-native.env.example` to
`%LOCALAPPDATA%\agent-bridge\bridge.env`, set `BRIDGE_TOKEN` locally, replace
the `CODEX_COMMAND` placeholder with the verified `codex.exe` path, and run
`deploy/windows-native/install-scheduled-task.ps1` from an elevated PowerShell
only if the normal user task registration is refused.

The task runs at user logon and uses the checked-out NTFS directory. It does
not use WSL, systemd, or a second Codex profile. Windows updates use the Bridge
self-updater and an NTFS junction at `.runtime/current`; do not copy source
files into the running checkout or switch the junction by hand unless
recovering a failed release.

## Windows Bridge release checklist

An update is not delivered when a commit is pushed or when a release directory
has been downloaded. The release must be staged from the pushed commit and
pass all of these checks before it becomes active:

```powershell
$root = "$env:LOCALAPPDATA\agent-bridge"
$current = (Get-Item "$root\current").Target
$version = (Get-Content "$root\current\package.json" -Raw | ConvertFrom-Json).version
$protocol = Test-Path "$root\current\apps\bridge\node_modules\@agent-bridge\protocol\package.json"
$process = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'bun.exe' -and $_.CommandLine -match 'apps[/\\]bridge[/\\]src[/\\]index\.ts'
}
"current=$current version=$version protocol=$protocol pid=$($process.ProcessId)"
```

The workspace dependency must be installed under
`apps/bridge/node_modules`, because Bun resolves the Bridge entrypoint from
that package directory. The updater validates this before switching the
junction, and `start-bridge.ps1` rejects an incomplete release as a second
line of defense.

After activation, verify the Bridge log contains `Bridge registered` and that
the process remains alive. Only then is the update complete. If activation
fails, keep the previous release available for rollback and do not claim that
the Windows client is updated.

Never restart while the Bridge reports active turns, pending approvals, or
pending user input. A failed or manually staged release must be repaired from
the pushed Git commit with `pnpm install --frozen-lockfile` and `pnpm check`,
then activated through the scheduled restart task.

The DSH Agent Control plugin is installed into the existing `desktop` profile.
Its Host token belongs in the DSH backend environment as
`AGENT_BRIDGE_CONTROL_TOKEN`; it must not be placed in browser configuration.
When DSH runs on HAL, keep Kanban in HAL's existing Hermes sidecar. Do not
create a Windows Hermes database or a competing DSH Host.

## Updating the installed DSH client

For client-only UI iterations, run from the repository root:

```powershell
pnpm --filter dsh-agent-control-plugin check
./deploy/windows-native/update-dsh-client.ps1
```

The updater replaces the existing desktop profile's built client and source map,
backs them up under `deploy-backups/agent-control`, and verifies both the installed
file and the bundle served by the local DSH server against the build's SHA256.
The server origin is discovered from the running TokensCowork process's listening
ports and verified before any replacement. Use `-DesktopOrigin http://127.0.0.1:PORT`
if more than one server is running. Ports can change across Desktop launches.
It preserves the Host process, Bridge credentials, and remote Hermes configuration.
It does not deploy Host changes. Reload the renderer if the new version marker
does not appear; an active client-module reload may apply the update automatically.
To roll back, restore both backed-up files using temporary copies and replacement
(rather than overwriting pnpm hardlinks), then reload the renderer.
