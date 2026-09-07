param([string]$TaskName = 'Agent Bridge (dev-windows)')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$start = Join-Path $PSScriptRoot 'start-bridge.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$start`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Description 'Windows-native Agent Bridge' -Force | Out-Null
Write-Output "Installed $TaskName"
