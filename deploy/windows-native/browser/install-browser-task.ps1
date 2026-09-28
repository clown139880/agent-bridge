param(
    [string]$TaskName = 'Agent Bridge Browser',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'start-agent-browser.ps1'),
    [string]$ProfileDirectory,
    [string]$BrowserPath
)
$ErrorActionPreference = 'Stop'
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
foreach ($name in @('ScriptPath', 'ProfileDirectory', 'BrowserPath')) {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value -and $value.Contains('"')) { throw "$name must not contain a double quote" }
    if ($value -and $name -ne 'ScriptPath') { $arguments += " -$name `"$value`"" }
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# No restart policy: the launcher exits once Chrome is up. If the user closes the
# browser it stays closed until an agent runs `schtasks /Run /TN "Agent Bridge Browser"`.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Shared agent browser (isolated profile, DevTools on 127.0.0.1)' -Force | Out-Null
Write-Output "Installed $TaskName"
