param([string]$EnvFile = "$env:LOCALAPPDATA\agent-bridge\bridge.env")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:BRIDGE_ENV_FILE = $EnvFile
Set-Location $root
& pnpm.cmd start:bridge 2>> "$env:LOCALAPPDATA\agent-bridge\bridge.log"
