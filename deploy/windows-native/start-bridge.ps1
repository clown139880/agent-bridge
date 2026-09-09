param(
    [string]$EnvFile = "$env:LOCALAPPDATA\agent-bridge\bridge.env",
    [string]$PnpmPath,
    [string]$BunPath,
    [string]$LogDirectory = "$env:LOCALAPPDATA\agent-bridge"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:BRIDGE_ENV_FILE = $EnvFile
Set-Location $root
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory 'bridge.log'
try {
    $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    $fallbackPnpm = Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.cmd'
    if ($PnpmPath) { $runtime = $PnpmPath }
    elseif ($pnpmCommand) { $runtime = $pnpmCommand.Source }
    elseif (Test-Path -LiteralPath $fallbackPnpm) { $runtime = $fallbackPnpm }
    else { throw 'pnpm.cmd was not found; pass -PnpmPath with an absolute path' }
    $runtimeArgs = 'start:bridge'
    # Task Scheduler can terminate this PowerShell wrapper without terminating a
    # process created by Start-Process. Clean up only an older Bridge launched
    # with this exact runtime before starting its replacement.
    $staleBridges = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and
        $_.ExecutablePath -and
        $_.ExecutablePath -ieq $runtime -and
        $_.CommandLine -match 'apps[/\\]bridge[/\\]src[/\\]index\.ts'
    })
    if ($staleBridges.Count -gt 0) {
        $processes = @(Get-CimInstance Win32_Process)
        function Stop-AgentBridgeProcessTree([int]$ProcessId) {
            foreach ($child in @($processes | Where-Object { $_.ParentProcessId -eq $ProcessId })) {
                Stop-AgentBridgeProcessTree $child.ProcessId
            }
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        }
        foreach ($stale in $staleBridges) {
            Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Stopping stale Bridge process tree: $($stale.ProcessId)"
            Stop-AgentBridgeProcessTree $stale.ProcessId
        }
    }
    # Redirect at process level so PowerShell 5.1 does not treat native stderr as an error.
    $protocolPackage = Join-Path $root 'apps\bridge\node_modules\@agent-bridge\protocol\package.json'
    if (-not (Test-Path -LiteralPath $protocolPackage -PathType Leaf)) {
        throw "Bridge release is incomplete: missing $protocolPackage"
    }
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Starting $runtime $runtimeArgs in $root"
    $process = Start-Process -FilePath $runtime -ArgumentList $runtimeArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $logDirectory 'bridge.err.log') -Wait -PassThru
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Bridge exited: $($process.ExitCode)"
    exit $process.ExitCode
} catch {
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Bridge startup failed: $_"
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) Bridge startup failed: $_"
    exit 1
}
