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
