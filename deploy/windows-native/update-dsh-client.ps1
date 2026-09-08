param(
  [string]$ProfileDirectory = (Join-Path $env:USERPROFILE '.dsh/profiles/desktop'),
  [string]$DesktopOrigin = ''
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../integrations/dsh-agent-control/lib'))
$sourceManifest = [IO.Path]::GetFullPath((Join-Path $sourceRoot '../package.json'))
$profileRoot = (Resolve-Path -LiteralPath $ProfileDirectory).Path
$installedRoot = (Resolve-Path -LiteralPath (Join-Path $profileRoot 'node_modules/dsh-agent-control-plugin')).Path
$manifest = Get-Content -LiteralPath (Join-Path $installedRoot 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'dsh-agent-control-plugin') { throw 'Unexpected installed plugin.' }
if (-not $DesktopOrigin) {
  $desktopProcessIds = @(Get-Process TokensCowork -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $candidates = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $desktopProcessIds } | Select-Object -ExpandProperty LocalPort -Unique)
  $origins = @()
  foreach ($port in $candidates) {
    $candidateOrigin = 'http://127.0.0.1:' + $port
    try {
      $probe = Invoke-WebRequest -Uri ($candidateOrigin + '/plugins/dsh-agent-control-plugin/client.js') -TimeoutSec 3 -SkipHttpErrorCheck
      if (($probe.StatusCode -eq 200 -and $probe.Content -match 'dsh-agent-control-plugin') -or $probe.StatusCode -eq 403) { $origins += $candidateOrigin }
    } catch { }
  }
  if ($origins.Count -ne 1) { throw 'Could not identify one running DSH server. Supply -DesktopOrigin explicitly. No client files changed.' }
  $DesktopOrigin = $origins[0]
}
$origin = [Uri]$DesktopOrigin
if (-not $origin.IsLoopback -or $origin.Scheme -ne 'http') { throw 'DesktopOrigin must be a local HTTP Desktop server.' }
# Check reachability and both browser/Host build outputs before creating a backup or changing installed files.
$preflight = Invoke-WebRequest -Uri ($DesktopOrigin.TrimEnd('/') + '/plugins/dsh-agent-control-plugin/client.js') -TimeoutSec 5 -SkipHttpErrorCheck
$authenticatedServer = $preflight.StatusCode -in @(401, 403)
# Recent Desktop builds serve browser plugins only through the combined
# `/plugins/??...` bundle. In compatibility mode the legacy per-plugin URL is
# therefore 404 while the root correctly requires authentication.
if ($preflight.StatusCode -eq 404) {
  $rootProbe = Invoke-WebRequest -Uri ($DesktopOrigin.TrimEnd('/') + '/') -TimeoutSec 5 -SkipHttpErrorCheck
  $authenticatedServer = $rootProbe.StatusCode -in @(401, 403)
}
if (-not $authenticatedServer -and ($preflight.StatusCode -ne 200 -or $preflight.Content -notmatch 'dsh-agent-control-plugin')) { throw 'The selected server is not serving Agent Control.' }
$artifacts = @('index.js', 'index.js.map', 'client.js', 'client.js.map')
foreach ($name in $artifacts) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $name) -PathType Leaf)) { throw "Build output missing: $name" }
}
$targetRoot = (Resolve-Path -LiteralPath (Join-Path $installedRoot 'lib')).Path
$backupRoot = Join-Path $profileRoot ('deploy-backups/agent-control/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $installedRoot 'package.json') -Destination (Join-Path $backupRoot 'package.json')
foreach ($name in $artifacts) {
  $source = Join-Path $sourceRoot $name
  $target = [IO.Path]::GetFullPath((Join-Path $targetRoot $name))
  $temporary = [IO.Path]::GetFullPath(($target + '.deploy-' + [Guid]::NewGuid().ToString('N')))
  if ([IO.Path]::GetDirectoryName($target) -ne $targetRoot -or [IO.Path]::GetDirectoryName($temporary) -ne $targetRoot) { throw 'Target escaped installed plugin lib directory.' }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Build output missing: $name" }
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $backupRoot $name) }
  # Replace the directory entry, rather than overwriting a pnpm hardlink in place.
  Copy-Item -LiteralPath $source -Destination $temporary
  Move-Item -LiteralPath $temporary -Destination $target -Force
  if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Installed hash mismatch: $name" }
}
$targetManifest = [IO.Path]::GetFullPath((Join-Path $installedRoot 'package.json'))
$temporaryManifest = [IO.Path]::GetFullPath(($targetManifest + '.deploy-' + [Guid]::NewGuid().ToString('N')))
if ([IO.Path]::GetDirectoryName($targetManifest) -ne $installedRoot -or [IO.Path]::GetDirectoryName($temporaryManifest) -ne $installedRoot) { throw 'Manifest target escaped installed plugin directory.' }
Copy-Item -LiteralPath $sourceManifest -Destination $temporaryManifest
Move-Item -LiteralPath $temporaryManifest -Destination $targetManifest -Force
if ((Get-FileHash -LiteralPath $sourceManifest).Hash -ne (Get-FileHash -LiteralPath $targetManifest).Hash) { throw 'Installed manifest hash mismatch.' }
$sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'client.js')).Hash
$hostHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'index.js')).Hash
$manifestHash = (Get-FileHash -LiteralPath $sourceManifest).Hash
if (-not $authenticatedServer) {
  $served = Invoke-WebRequest -Uri ($DesktopOrigin.TrimEnd('/') + '/plugins/dsh-agent-control-plugin/client.js?deployment=' + $sourceHash.Substring(0,12)) -Headers @{ 'Cache-Control' = 'no-cache' }
  $servedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($served.RawContentStream.ToArray()))
  if ($servedHash -ne $sourceHash) { throw "Desktop served a different bundle. Backup: $backupRoot" }
}
$status = if ($authenticatedServer) { 'Host and client deployed; installed hashes verified (Desktop HTTP authentication active)' } else { 'Host and client deployed; client served hash verified' }
[pscustomobject]@{ Status=$status; Sha256=$sourceHash; HostSha256=$hostHash; ManifestSha256=$manifestHash; Backup=$backupRoot; Origin=$DesktopOrigin; Reload='Restart Desktop to activate the Host and renderer changes.' } | ConvertTo-Json
