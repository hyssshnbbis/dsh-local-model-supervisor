#requires -Version 7
<#
  unload-local-models.ps1 - release the GPU right now, by stopping every local model.

  This is the "close all local models" switch. It deliberately KEEPS the supervisor running,
  so the next inference request starts a model again automatically. Use stop-supervisor.ps1 if
  you want to disable the auto-start behaviour entirely.

  Works in both modes:
    * supervisor mode -> POST /__supervisor/unload (graceful, supervisor stays up)
    * manual mode     -> kills llama-server directly (what stop-server.ps1 does)

  Examples:
    pwsh -File unload-local-models.ps1
    pwsh -File unload-local-models.ps1 -WhatIf
#>
param(
    [int[]]$Ports = @(8080, 8081),
    [switch]$WhatIf,
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Get-GpuFreeMiB {
    $v = (nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    if ($v -match '(\d+)') { return [int]$Matches[1] } else { return $null }
}

$before = Get-GpuFreeMiB
$procs  = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue)
$sup    = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*supervisor.js*' })

if (-not $Quiet) {
    Write-Host '============= close all local models =============' -ForegroundColor Cyan
    Write-Host (" supervisor      : {0}" -f $(if ($sup) { "running (pid $($sup.ProcessId -join ','))" } else { 'not running (manual mode)' }))
    Write-Host (" llama-server    : {0}" -f $(if ($procs) { "$($procs.Count) process(es)" } else { 'none' }))
    foreach ($p in $procs) {
        $port = if ($p.CommandLine -match '--port\s+(\d+)') { $Matches[1] } else { '?' }
        $mdl  = if ($p.CommandLine -match '--model\s+(\S+)') { Split-Path $Matches[1] -Leaf } else { '?' }
        Write-Host ("   pid {0,-7} port {1,-6} {2}" -f $p.ProcessId, $port, $mdl)
    }
    Write-Host (" GPU free before : {0} MiB" -f $before)
    Write-Host '--------------------------------------------------'
}

if ($WhatIf) {
    Write-Host 'WhatIf: nothing was stopped.' -ForegroundColor Yellow
    exit 0
}

$stoppedViaSupervisor = $false
if ($sup) {
    foreach ($port in $Ports) {
        try {
            $r = Invoke-RestMethod "http://127.0.0.1:$port/__supervisor/unload" -Method Post -TimeoutSec 60
            $stoppedViaSupervisor = $true
            if (-not $Quiet) { Write-Host (" asked the supervisor on port {0} to unload" -f $port) -ForegroundColor Green }
            break
        } catch { }
    }
    if (-not $stoppedViaSupervisor -and -not $Quiet) {
        Write-Host ' supervisor did not answer /__supervisor/unload; falling back to killing processes' -ForegroundColor Yellow
    }
}

if (-not $stoppedViaSupervisor) {
    foreach ($p in $procs) {
        Write-Host (" stopping llama-server pid {0}" -f $p.ProcessId)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# wait for the VRAM to actually come back
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    $remaining = @(Get-Process llama-server -ErrorAction SilentlyContinue)
    $now = Get-GpuFreeMiB
    if ($remaining.Count -eq 0 -and $null -ne $now -and $null -ne $before -and $now -gt $before) { break }
}

$after     = Get-GpuFreeMiB
$remaining = @(Get-Process llama-server -ErrorAction SilentlyContinue)

if (-not $Quiet) {
    Write-Host (" GPU free after  : {0} MiB" -f $after) -ForegroundColor Green
    if ($null -ne $before -and $null -ne $after) {
        Write-Host (" released        : {0} MiB" -f ($after - $before)) -ForegroundColor Green
    }
    if ($sup) {
        Write-Host ' supervisor still running - the next request starts a model again.' -ForegroundColor DarkGray
    }
}

if ($remaining.Count -gt 0) {
    Write-Host ("WARNING: llama-server still alive: pid {0}" -f ($remaining.Id -join ',')) -ForegroundColor Red
    exit 1
}
if (-not $Quiet) { Write-Host 'all local models are closed.' -ForegroundColor Green }
exit 0
