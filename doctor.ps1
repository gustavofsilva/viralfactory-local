. (Join-Path $PSScriptRoot 'scripts/common.ps1')
Set-Location -LiteralPath $ProjectRoot
if (-not (Test-Path -LiteralPath 'node_modules')) { throw 'Execute .\install.ps1 primeiro.' }
Invoke-ProjectNpm @('run', 'doctor')
