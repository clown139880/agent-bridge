param(
    [string]$ProfileDirectory = 'C:\Tools\agent-bridge\browser\profile',
    [int]$Port = 9222,
    [string]$BrowserPath
)
$ErrorActionPreference = 'Stop'

function Test-DevTools {
    try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/json/version" | Out-Null
        return $true
    } catch { return $false }
}

# One shared instance: agents call the scheduled task whenever the endpoint is
# down, so starting an already running browser must be a no-op.
if (Test-DevTools) { Write-Output "Agent browser already listening on 127.0.0.1:$Port"; exit 0 }

if (-not $BrowserPath) {
    $BrowserPath = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $BrowserPath) { throw 'Neither Chrome nor Edge was found; pass -BrowserPath' }

# The dedicated user data directory keeps agent logins and history out of the
# user's own browser, and Chrome 136+ requires a non-default one for remote
# debugging. DevTools binds to 127.0.0.1 only; WSL reaches it via cdp-relay.mjs.
New-Item -ItemType Directory -Force -Path $ProfileDirectory | Out-Null
Start-Process -FilePath $BrowserPath -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$ProfileDirectory`"",
    '--no-first-run',
    '--no-default-browser-check'
)

for ($i = 0; $i -lt 30; $i++) {
    if (Test-DevTools) { Write-Output "Agent browser listening on 127.0.0.1:$Port"; exit 0 }
    Start-Sleep -Milliseconds 500
}
throw "Agent browser did not open DevTools on 127.0.0.1:$Port"
