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
    # Redirect at process level so PowerShell 5.1 does not treat native stderr as an error.
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Starting $runtime $runtimeArgs in $root"
    $process = Start-Process -FilePath $runtime -ArgumentList $runtimeArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError (Join-Path $logDirectory 'bridge.err.log') -Wait -PassThru
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Bridge exited: $($process.ExitCode)"
    exit $process.ExitCode
} catch {
    Add-Content -LiteralPath (Join-Path $logDirectory 'launcher.log') -Value "$(Get-Date -Format o) Bridge startup failed: $_"
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) Bridge startup failed: $_"
    exit 1
}
