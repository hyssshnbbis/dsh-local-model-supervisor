#requires -Version 7
<#
  supervisor-helpers.ps1 - shared helpers for the PowerShell scripts in this folder.

  Dot-source this file, then call Get-LocalModelPorts / Get-SupervisorProcess.
#>

<#
  Get-LocalModelPorts - which ports is the supervisor listening on?

  Read from the supervisor config through `supervisor.js --dump-models`, so the allocation rules
  are not duplicated here. That is what keeps these scripts working when the user declares more
  than a couple of models, or moves `ports.publicBase` away from 8080 — with a hardcoded
  @(8080, 8081) both of those cases silently stop matching.

  Falls back to 8080/8081 when node, the config or the supervisor script is unavailable.
#>
function Get-LocalModelPorts {
    param(
        [string]$Config = '',
        [int[]]$Fallback = @(8080, 8081)
    )

    try {
        $root = Split-Path $PSScriptRoot -Parent
        if (-not $Config) { $Config = Join-Path $root 'supervisor\models.json' }
        if (-not (Test-Path $Config)) { return $Fallback }

        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { return $Fallback }

        $supervisor = Join-Path $root 'supervisor\supervisor.js'
        if (-not (Test-Path $supervisor)) { return $Fallback }

        $json = & $node $supervisor $Config --dump-models 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $json) { return $Fallback }

        $ports = @(($json | ConvertFrom-Json).models |
                   ForEach-Object { [int]$_.publicPort } |
                   Where-Object { $_ -gt 0 } |
                   Select-Object -Unique)
        if ($ports.Count -eq 0) { return $Fallback }
        return $ports
    } catch {
        return $Fallback
    }
}

<#
  Get-SupervisorProcess - find running supervisor processes.

  Matching on `Name='node.exe'` is NOT enough: the DSH plugin starts the supervisor through the
  Electron binary with ELECTRON_RUN_AS_NODE=1, so its image name is "DeepSeek Harness.exe". A
  node.exe-only filter therefore misses exactly the supervisor the plugin started — the normal
  case on a machine that has the plugin installed.

  So match on the command line instead, and exclude:
    * shells — whose command line contains "supervisor.js" merely because they were asked to
      stop/start it (their arguments are part of the command line!)
    * the DSH subprocess runner (runner.js), which hosts those shells and would otherwise be
      matched and killed, taking the caller's own command down with it
#>
function Get-SupervisorProcess {
    param(
        # Optional: only match supervisors running this exact script path.
        [string]$ScriptPath = ''
    )

    $self = $PID
    $shells = @('pwsh.exe', 'powershell.exe', 'cmd.exe', 'conhost.exe', 'wsl.exe', 'WindowsTerminal.exe', 'OpenConsole.exe')

    return @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessId -ne $self -and
            $_.Name -and $shells -notcontains $_.Name -and
            $_.CommandLine -and
            $_.CommandLine -like '*supervisor.js*' -and
            $_.CommandLine -notlike '*-Command*' -and
            $_.CommandLine -notlike '*-EncodedCommand*' -and
            $_.CommandLine -notlike '*runner.js*' -and
            (-not $ScriptPath -or $_.CommandLine -like "*$ScriptPath*")
        }
    )
}

<#
  Resolve-NodeExe - find a real node.exe, preferring one that is not a version-manager shim.

  `node` on PATH is often a shim: nvm-windows puts a junction to its .shim directory there, and
  that shim is an EXTRA process which re-executes the real interpreter. For a supervisor whose
  entire job is to sit idle, paying an extra process plus ~6 MB of resident memory buys nothing.

  Order: $env:DSH_LOCAL_MODEL_NODE, extra candidates, the Node runtime DSH ships with, PATH
  entries that are not shims, and finally whatever `node` resolves to.
#>
function Resolve-NodeExe {
    param([string[]]$ExtraCandidates = @())

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($env:DSH_LOCAL_MODEL_NODE) { $candidates.Add($env:DSH_LOCAL_MODEL_NODE) }
    foreach ($c in $ExtraCandidates) { if ($c) { $candidates.Add($c) } }

    # DSH ships its own Node runtime; it is a real binary and is present on any DSH machine.
    $rt = Join-Path $HOME '.dsh\dsh-runtimes'
    if (Test-Path -LiteralPath $rt) {
        Get-ChildItem -LiteralPath $rt -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $candidates.Add((Join-Path $_.FullName 'dependencies\node\bin\node.exe'))
        }
    }

    foreach ($dir in ($env:PATH -split ';')) {
        if (-not $dir) { continue }
        $d = $dir.Trim('"').TrimEnd('\')
        if ($d -like '*\.shim' -or $d -like '*nvm\.nodejs*') { continue }
        $candidates.Add((Join-Path $d 'node.exe'))
    }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
    }

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
