#requires -Version 7
<#
  install-autostart.ps1 - make the local-model supervisor start automatically at logon.

  Registers a per-user Windows Scheduled Task (no administrator rights needed, no service,
  nothing runs as SYSTEM):

      task name : DSH-LocalModel-Supervisor
      trigger   : at logon of the current user, 30s delay (let the desktop settle first)
      action    : pwsh -WindowStyle Hidden -File scripts\start-supervisor.ps1

  The supervisor itself only occupies ~30 MB of RAM and NO VRAM: models are still started on
  demand and released after the idle timeout. Starting it at logon just means the two DSH
  routes stop being dead after a reboot.

  If Scheduled Task registration is refused (permissions), this falls back to a shortcut in
  the user's Startup folder.

  Examples:
    pwsh -File install-autostart.ps1
    pwsh -File install-autostart.ps1 -DelaySeconds 90
    pwsh -File uninstall-autostart.ps1
#>
param(
    [string]$TaskName = 'DSH-LocalModel-Supervisor',
    [int]$DelaySeconds = 30,
    [switch]$ForceStartupFolder
)

$ErrorActionPreference = 'Stop'
$root   = Split-Path $PSScriptRoot -Parent
$script = Join-Path $root 'scripts\start-supervisor.ps1'
if (-not (Test-Path $script)) { throw "start-supervisor.ps1 not found at $script" }

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { throw 'pwsh.exe not found on PATH' }

$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath    = Join-Path $startupDir "$TaskName.lnk"
$arguments  = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' autostart: local-model supervisor at logon' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host (" task name    : {0}" -f $TaskName)
Write-Host (" action       : pwsh -File {0}" -f $script)
Write-Host (" trigger      : at logon of {0}, +{1}s" -f $env:USERNAME, $DelaySeconds)
Write-Host '------------------------------------------------------------'

$taskOk = $false
$taskErr = $null

if (-not $ForceStartupFolder) {
    try {
        $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $root

        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        # small delay so the desktop / GPU driver has settled before we bind the ports
        $trigger.Delay = "PT$($DelaySeconds)S"

        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force `
            -Description 'Lazily starts the local llama.cpp model supervisor at logon. Models are still started on demand and released after the idle timeout.' | Out-Null

        $taskOk = $true
        Write-Host ' registered a Scheduled Task.' -ForegroundColor Green
    } catch {
        $taskErr = $_.Exception.Message
        Write-Host (" Scheduled Task registration failed: {0}" -f $taskErr) -ForegroundColor Yellow
        Write-Host ' falling back to a Startup-folder shortcut ...' -ForegroundColor Yellow
    }
}

if (-not $taskOk) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $pwsh
    $lnk.Arguments        = $arguments
    $lnk.WorkingDirectory = $root
    $lnk.WindowStyle      = 7          # minimized; pwsh also hides its own window
    $lnk.Description      = 'Lazily starts the local llama.cpp model supervisor at logon'
    $lnk.Save()
    Write-Host (" created startup shortcut: {0}" -f $lnkPath) -ForegroundColor Green
}

Write-Host ''
Write-Host '--- verification ---' -ForegroundColor Cyan
if ($taskOk) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        Write-Host (" state  : {0}" -f $t.State)
        Write-Host (" action : {0} {1}" -f $t.Actions[0].Execute, $t.Actions[0].Arguments)
        Write-Host (" trigger: {0}" -f ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }))
    }
    Write-Host ''
    Write-Host 'Run it now to test:  Start-ScheduledTask -TaskName ' -NoNewline
    Write-Host $TaskName
    Write-Host 'Remove it with:      pwsh -File uninstall-autostart.ps1'
} else {
    if (Test-Path $lnkPath) { Write-Host (" shortcut present: {0}" -f $lnkPath) }
    Write-Host 'Remove it with:      pwsh -File uninstall-autostart.ps1'
}
