#requires -Version 7
<#
  start-supervisor.ps1 - start the lazy local-model supervisor.

  The supervisor takes over the public ports 8080 / 8081 (the ones DSH already points at) and
  runs llama-server on private internal ports 9080 / 9081 only while it is needed:
    first inference request -> model is started automatically
    500s with no inference  -> model is stopped automatically and VRAM is released

  Because it listens on the same ports, no DSH configuration has to change. It does mean the
  supervisor mode is exclusive with running llama-server yourself: this script stops any
  running llama-server (and any previous supervisor) before it starts.

  The checkout is relocatable: paths are derived from this script's own location, so it does
  not matter where you clone the repo.

  Examples:
    pwsh -File start-supervisor.ps1
    pwsh -File start-supervisor.ps1 -IdleTimeoutSec 300
    pwsh -File supervisor-status.ps1          # what is loaded right now
    pwsh -File stop-supervisor.ps1            # stop the supervisor itself
#>
param(
    [string]$Config = '',              # '' = <repo>\supervisor\models.json
    [int]$IdleTimeoutSec = 0,          # 0 = use the value in models.json (500)
    [int]$MaxOldSpaceMb = 64,          # V8 heap cap; the supervisor holds no large data structures
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'supervisor-helpers.ps1')
$root    = Split-Path $PSScriptRoot -Parent
if (-not $Config) { $Config = Join-Path $root 'supervisor\models.json' }
$script  = Join-Path $root 'supervisor\supervisor.js'
$logDir  = Join-Path $root 'logs'
$outLog  = Join-Path $logDir 'supervisor.out.log'
$errLog  = Join-Path $logDir 'supervisor.err.log'

if (-not (Test-Path $script)) { throw "supervisor.js not found at $script" }
if (-not (Test-Path $Config)) { throw "config not found at $Config" }
# Resolve-NodeExe skips version-manager shims: `node` on PATH is often a shim that re-executes
# the real interpreter, costing an extra process and ~6 MB of resident memory for nothing.
$node = Resolve-NodeExe
if (-not $node) { throw 'no node.exe found (set DSH_LOCAL_MODEL_NODE to override)' }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ---- stop anything that would fight for the ports --------------------------------
$supProcs = Get-SupervisorProcess
foreach ($p in $supProcs) {
    Write-Host ("stopping previous supervisor pid {0} ({1})" -f $p.ProcessId, $p.Name) -ForegroundColor Yellow
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($supProcs) { Start-Sleep -Seconds 2 }

$manual = @(Get-Process llama-server -ErrorAction SilentlyContinue)
if ($manual.Count -gt 0) {
    if ($KeepRunning) { throw "llama-server is already running (pid $($manual.Id -join ',')); stop it first or drop -KeepRunning" }
    Write-Host ("stopping manually started llama-server (pid {0}) - the supervisor owns the GPU from now on" -f ($manual.Id -join ',')) -ForegroundColor Yellow
    $manual | Stop-Process -Force
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (-not (Get-Process llama-server -ErrorAction SilentlyContinue)) { break } }
    Start-Sleep -Seconds 2
}

# ---- resolve what will actually run ----------------------------------------------
# Ports are NOT read straight off the entries: the unified schema allocates them from
# ports.publicBase when an entry does not set publicPort, so ask the same code the
# supervisor will use (Get-LocalModelPorts -> `supervisor.js --dump-models`).
$cfgJson = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$pubPorts = @(Get-LocalModelPorts -Config $Config)
$effectiveIdle = if ($IdleTimeoutSec -gt 0) { $IdleTimeoutSec } else { $cfgJson.idleTimeoutSec }
$modelNames = @($cfgJson.models | ForEach-Object {
    if ($_.label) { $_.label } elseif ($_.name) { $_.name } else { $_.key }
})
$modelKinds = @($cfgJson.models | ForEach-Object { if ($_.url) { 'external' } else { 'managed' } })
$modelList = for ($i = 0; $i -lt $modelNames.Count; $i++) {
    "{0} [{1}] -> {2}" -f $modelNames[$i], $modelKinds[$i], $pubPorts[$i]
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' local model supervisor (lazy start / idle shutdown)' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host (" public ports : {0}   ({1} model(s); DSH points here)" -f ($pubPorts -join ', '), $modelNames.Count)
Write-Host (" idle timeout : {0}s without inference -> model stopped, VRAM released" -f $effectiveIdle)
Write-Host (" models       : {0}" -f ($modelList -join "`n                "))
Write-Host (" log          : {0}" -f $outLog)
Write-Host '------------------------------------------------------------'

# Only re-serialise the config when we actually need to change something; otherwise let the
# supervisor read the real file so nothing is lost in a round-trip.
if ($IdleTimeoutSec -gt 0) {
    $cfgJson.idleTimeoutSec = $IdleTimeoutSec
    $tmpCfg = Join-Path $logDir 'supervisor.effective.json'
    $cfgJson | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmpCfg -Encoding utf8
} else {
    $tmpCfg = $Config
}

# Launch through a generated .cmd rather than Start-Process -RedirectStandardOutput:
# redirecting from PowerShell leaves the caller holding the child's pipe handles, so the
# command never appears to finish. The .cmd owns its own redirection (same trick as
# start-server.ps1) and detaches cleanly.
$batFile = Join-Path $logDir 'run-supervisor.cmd'
$batBody = @(
    '@echo off',
    'REM generated by scripts\start-supervisor.ps1 - edit that script, not this file',
    # --max-old-space-size caps what V8 is willing to grow to. The supervisor holds no big data
    # structures, so letting the heap balloon to its ~2 GB default only inflates resident memory.
    ('"{0}" --max-old-space-size={4} "{1}" "{2}" > "{3}" 2>&1' -f $node, $script, $tmpCfg, $outLog, $MaxOldSpaceMb)
) -join "`r`n"
[IO.File]::WriteAllText($batFile, $batBody, [Text.UTF8Encoding]::new($false))
Start-Process -FilePath $batFile -WindowStyle Hidden

# ---- wait until every public port answers ---------------------------------------
$ok = $true
foreach ($port in $pubPorts) {
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try { $null = Invoke-RestMethod "http://127.0.0.1:$port/__supervisor/status" -TimeoutSec 3; $ready = $true; break } catch { }
    }
    if ($ready) { Write-Host (" listening on 127.0.0.1:{0}" -f $port) -ForegroundColor Green }
    else        { Write-Host (" NOT listening on 127.0.0.1:{0}" -f $port) -ForegroundColor Red; $ok = $false }
}

$gpu = nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader
Write-Host (" GPU now      : {0}  (no model is started until the first request)" -f $gpu)
if (-not $ok) { Write-Host "check $errLog" -ForegroundColor Red; exit 1 }
Write-Host ''
Write-Host 'send a chat request and it will start the model automatically.' -ForegroundColor DarkGray
