param(
    [string]$EnvFile = "$env:LOCALAPPDATA\agent-bridge\bridge.env",
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
    $bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue
    $bundledBun = Join-Path $logDirectory 'runtime\bun-windows-x64\bun.exe'
    if ($BunPath) {
        $runtime = $BunPath
        $runtimeArgs = 'apps/bridge/src/index.ts'
    } elseif ($bunCommand) {
        $runtime = $bunCommand.Source
        $runtimeArgs = 'apps/bridge/src/index.ts'
    } elseif (Test-Path -LiteralPath $bundledBun) {
        $runtime = $bundledBun
        $runtimeArgs = 'apps/bridge/src/index.ts'
    } else {
        $runtime = (Get-Command node.exe -ErrorAction Stop).Source
        $runtimeArgs = '--import tsx apps/bridge/src/index.ts'
    }
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
