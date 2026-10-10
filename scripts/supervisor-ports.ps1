#requires -Version 7
<#
  supervisor-ports.ps1 - shared helper: which ports is the local-model supervisor listening on?

  Dot-source this file, then call Get-LocalModelPorts.

  The ports are read from the supervisor config through `supervisor.js --dump-models`, so the
  allocation rules are not duplicated here. That is what keeps these helper scripts working when
  the user declares more than a couple of models, or moves `ports.publicBase` somewhere other
  than 8080 — with a hardcoded @(8080, 8081) both of those cases silently stop matching.

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
