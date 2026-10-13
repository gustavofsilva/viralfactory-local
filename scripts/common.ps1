$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
function Get-ProjectDataDirectory {
    $configured = './data'
    $environmentFile = Join-Path $ProjectRoot '.env'
    if (Test-Path -LiteralPath $environmentFile) {
        foreach ($line in Get-Content -LiteralPath $environmentFile) {
            if ($line -match '^\s*DATA_DIR\s*=\s*(.+?)\s*$') { $configured = $Matches[1].Trim('"', "'") }
        }
    }
    if ($env:DATA_DIR) { $configured = $env:DATA_DIR }
    $target = if ([System.IO.Path]::IsPathRooted($configured)) { [System.IO.Path]::GetFullPath($configured) } else { [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $configured)) }
    return $target
}
function Invoke-ProjectNpm {
    param([string[]]$Arguments)
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm falhou com codigo $LASTEXITCODE." }
}
