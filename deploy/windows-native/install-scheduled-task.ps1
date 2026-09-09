param(
    [string]$TaskName = 'Agent Bridge (dev-windows)',
    [string]$InstallRoot = "$env:LOCALAPPDATA\agent-bridge",
    [string]$PnpmPath,
    [string]$EnvFile,
    [string]$LogDirectory
)
$ErrorActionPreference = 'Stop'
$currentRoot = Join-Path $InstallRoot 'current'
$start = Join-Path $currentRoot 'deploy\windows-native\start-bridge.ps1'
$restart = Join-Path $currentRoot 'deploy\windows-native\restart-bridge.ps1'
$restartTaskName = "$TaskName Restart"
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`""
foreach ($name in @('PnpmPath', 'EnvFile', 'LogDirectory')) {
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
$restartArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$restart`" -TaskName `"$TaskName`""
$restartAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $restartArguments
$restartSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $restartTaskName -Action $restartAction -Settings $restartSettings -Description 'Restart the Windows-native Agent Bridge after an atomic release switch' -Force | Out-Null
Write-Output "Installed $TaskName and $restartTaskName"
