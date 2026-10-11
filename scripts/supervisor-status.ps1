#requires -Version 7
<#
  supervisor-status.ps1 - show what the local-model supervisor currently has loaded,
  how long until each model is released, and the live GPU state.
#>
param(
    [string]$Config = '',
    [int[]]$Ports = @()
)

$ErrorActionPreference = 'Continue'

# Ports come from the supervisor config so any number of models / any publicBase works.
. (Join-Path $PSScriptRoot 'supervisor-helpers.ps1')
if (-not $Ports -or $Ports.Count -eq 0) { $Ports = Get-LocalModelPorts -Config $Config }

$status = $null
$viaPort = $null
foreach ($port in $Ports) {
    try {
        $status = Invoke-RestMethod "http://127.0.0.1:$port/__supervisor/status" -TimeoutSec 5
        $viaPort = $port
        break
    } catch { }
}

if (-not $status) {
    Write-Host 'supervisor is NOT running (no /__supervisor/status on any port).' -ForegroundColor Yellow
    $proc = Get-Process llama-server -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host ("but a llama-server is running: pid {0} - that is manual mode" -f ($proc.Id -join ',')) -ForegroundColor Yellow
        Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
            ForEach-Object { "   $($_.CommandLine)" }
    }
    Write-Host ''
    Write-Host ("GPU: " + (nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader))
    exit 1
}

Write-Host '=============== local model supervisor ===============' -ForegroundColor Cyan
Write-Host (" supervisor pid : {0}   (status read from port {1})" -f $status.pid, $viaPort)
Write-Host (" idle timeout   : {0}s without inference -> released" -f $status.idleTimeoutSec)
if ($status.memory) {
    Write-Host (" resident memory: {0} MiB rss  ·  js heap {1} MiB  ·  external {2} MiB" -f `
        $status.memory.rssMiB, $status.memory.heapUsedMiB, $status.memory.externalMiB)
}
Write-Host ''
$status.models | ForEach-Object {
    $state = if ($_.starting) { 'STARTING' } elseif ($_.running) { 'LOADED' } else { 'unloaded' }
    $color = if ($_.running) { 'Green' } else { 'DarkGray' }
    Write-Host (" [{0,-11}] {1}" -f $_.key, $_.label) -ForegroundColor $color
    Write-Host ("    ports      : public {0} -> internal {1}" -f $_.publicPort, $_.internalPort)
    if ($_.softContextLimit) {
        $grace = if ($_.graceActive) { 'ACTIVE (compaction replay will be let through)' } else { 'idle' }
        Write-Host ("    context    : real {0} / soft ceiling {1}  -> {2} tokens of redundancy" -f `
            $_.realContextLimit, $_.softContextLimit, ($_.realContextLimit - $_.softContextLimit))
        Write-Host ("    grace      : {0}" -f $grace)
    } else {
        Write-Host  '    context    : soft ceiling disabled'
    }
    Write-Host ("    state      : {0}   active requests: {1}" -f $state, $_.activeRequests)
    if ($_.running) {
        Write-Host ("    idle       : {0}s   auto-release in {1}s" -f $_.idleSec, $_.stopInSec)
    } else {
        Write-Host  '    idle       : -   (will start on the next inference request)'
    }
    if ($_.lastError) { Write-Host ("    last error : {0}" -f $_.lastError) -ForegroundColor Red }
    Write-Host ''
}
Write-Host ("GPU: " + (nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader))
