#requires -Version 7
<#
  stop-supervisor.ps1 - stop the local-model supervisor and release the GPU.

  This stops the supervisor process itself (so nothing will auto-start models any more) and
  kills any llama-server it was managing. To merely release the GPU while keeping the lazy
  auto-start behaviour, use unload-local-models.ps1 instead.
#>
param(
    [string]$Config = '',
    [int[]]$Ports = @(),
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

# Ports come from the supervisor config so any number of models / any publicBase works.
. (Join-Path $PSScriptRoot 'supervisor-helpers.ps1')
if (-not $Ports -or $Ports.Count -eq 0) { $Ports = Get-LocalModelPorts -Config $Config }

function Get-GpuFreeMiB {
    $v = (nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
    if ($v -match '(\d+)') { return [int]$Matches[1] } else { return $null }
}

$before = Get-GpuFreeMiB

# 1. ask the supervisor to unload its models gracefully (best effort)
foreach ($port in $Ports) {
    try {
        Invoke-RestMethod "http://127.0.0.1:$port/__supervisor/unload" -Method Post -TimeoutSec 30 | Out-Null
        if (-not $Quiet) { Write-Host ("unloaded models via 127.0.0.1:{0}" -f $port) }
    } catch { }
}

# 2. stop the supervisor process (matches on the command line, not the image name — the plugin
#    starts it through the Electron binary, so it is NOT called node.exe)
$supProcs = Get-SupervisorProcess
if (-not $supProcs) {
    if (-not $Quiet) { Write-Host 'no supervisor process is running.' }
} else {
    foreach ($p in $supProcs) {
        if (-not $Quiet) { Write-Host ("stopping supervisor pid {0} ({1})" -f $p.ProcessId, $p.Name) }
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-SupervisorProcess)) { break }
    }
}

# 3. make sure no llama-server survived (also covers manually started ones)
$left = @(Get-Process llama-server -ErrorAction SilentlyContinue)
foreach ($p in $left) {
    if (-not $Quiet) { Write-Host ("stopping leftover llama-server pid {0}" -f $p.Id) }
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}

# 4. wait for VRAM to settle
$target = if ($null -ne $before) { $before } else { 0 }
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $now = Get-GpuFreeMiB
    if ($null -ne $now -and $now -ge $target) { break }
}

$after = Get-GpuFreeMiB
if (-not $Quiet) {
    Write-Host ''
    Write-Host ("GPU free before : {0} MiB" -f $before)
    Write-Host ("GPU free after  : {0} MiB" -f $after) -ForegroundColor Green
    if ($null -ne $before -and $null -ne $after) {
        Write-Host ("released        : {0} MiB" -f ($after - $before)) -ForegroundColor Green
    }
}

$remaining = @(Get-Process llama-server -ErrorAction SilentlyContinue)
if ($remaining.Count -gt 0) {
    Write-Host ("WARNING: llama-server still running: pid {0}" -f ($remaining.Id -join ',')) -ForegroundColor Red
    exit 1
}
if (-not $Quiet) { Write-Host 'supervisor stopped and no llama-server remains.' -ForegroundColor Green }
exit 0
