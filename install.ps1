param([switch]$Yes)
. (Join-Path $PSScriptRoot 'scripts/common.ps1')
Set-Location -LiteralPath $ProjectRoot
if (-not $Yes) {
    Write-Host 'Este script baixa dependencias npm no disco D e prepara o SQLite local.'
    Write-Host 'Nao instala programas globais nem altera a seguranca do Windows.'
    if ((Read-Host 'Continuar? [s/N]') -notmatch '^[sSyY]$') { return }
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Instale Node.js 22.12 ou superior.' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
& (Join-Path $PSScriptRoot 'scripts/configure-node-storage.ps1')
if (Test-Path -LiteralPath 'package-lock.json') { Invoke-ProjectNpm @('ci', '--no-audit', '--no-fund') } else { Invoke-ProjectNpm @('install', '--no-audit', '--no-fund') }
Invoke-ProjectNpm @('run', 'db:setup')
Invoke-ProjectNpm @('run', 'build')
Write-Host 'Instalacao local concluida. Execute .\start.ps1'
