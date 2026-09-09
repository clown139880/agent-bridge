param(
    [string]$TaskName = 'Agent Bridge (dev-windows)'
)
$ErrorActionPreference = 'Stop'

# This script runs in a separate scheduled task so stopping the main task does
# not terminate the process responsible for starting its replacement.
Start-Sleep -Seconds 2
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 250
    $state = (Get-ScheduledTask -TaskName $TaskName).State
} while ($state -eq 'Running' -and (Get-Date) -lt $deadline)
if ($state -eq 'Running') {
    throw "$TaskName did not stop within 20 seconds"
}
Start-ScheduledTask -TaskName $TaskName
