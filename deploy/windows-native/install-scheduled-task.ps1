param(
    [string]$TaskName = 'Agent Bridge (dev-windows)',
    [string]$BunPath,
    [string]$EnvFile,
    [string]$LogDirectory
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$start = Join-Path $PSScriptRoot 'start-bridge.ps1'
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
foreach ($name in @('BunPath', 'EnvFile', 'LogDirectory')) {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value) {
        if ($value.Contains('"')) { throw "$name must not contain a double quote" }
        $arguments += " -$name `"$value`""
    }
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Windows-native Agent Bridge' -Force | Out-Null
Write-Output "Installed $TaskName"
