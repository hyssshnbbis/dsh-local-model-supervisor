#requires -Version 7
<#
  uninstall-autostart.ps1 - remove the logon autostart of the local-model supervisor.

  Removes both possible mechanisms (Scheduled Task and Startup-folder shortcut) so it does not
  matter which one install-autostart.ps1 ended up using. By default the running supervisor is
  left alone; pass -StopSupervisor to also shut it down.

  Examples:
    pwsh -File uninstall-autostart.ps1
    pwsh -File uninstall-autostart.ps1 -StopSupervisor
#>
param(
    [string]$TaskName = 'DSH-LocalModel-Supervisor',
    [switch]$StopSupervisor
)

$ErrorActionPreference = 'Continue'

$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath    = Join-Path $startupDir "$TaskName.lnk"
$removed    = $false

# 1. Scheduled Task
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host ("unregistering scheduled task '{0}' ..." -f $TaskName)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Write-Host ("WARNING: task '{0}' still exists" -f $TaskName) -ForegroundColor Red
    } else {
        Write-Host ' scheduled task removed.' -ForegroundColor Green
        $removed = $true
    }
} else {
    Write-Host 'no scheduled task found.'
}

# 2. Startup-folder shortcut
if (Test-Path $lnkPath) {
    Write-Host ("removing startup shortcut: {0}" -f $lnkPath)
    Remove-Item -LiteralPath $lnkPath -Force
    Write-Host ' startup shortcut removed.' -ForegroundColor Green
    $removed = $true
} else {
    Write-Host 'no startup shortcut found.'
}

if ($StopSupervisor) {
    Write-Host ''
    Write-Host 'stopping the supervisor ...'
    & (Join-Path $PSScriptRoot 'stop-supervisor.ps1')
} elseif ($removed) {
    Write-Host ''
    Write-Host 'The running supervisor (if any) was left alone; it just will not start at logon any more.' -ForegroundColor DarkGray
}
