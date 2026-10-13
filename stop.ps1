. (Join-Path $PSScriptRoot 'scripts/common.ps1')
$taskDataDirectory = Get-ProjectDataDirectory
$pidFile = Join-Path $taskDataDirectory 'runtime/server.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'Nenhum servidor registrado.'; return }
$saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
if ($saved.root -ne $ProjectRoot) { throw 'O registro de processo nao pertence a este projeto.' }
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($saved.pid)" -ErrorAction SilentlyContinue
if ($processInfo) {
    if ($processInfo.Name -ne 'node.exe' -or -not $processInfo.CommandLine.Contains((Join-Path $ProjectRoot 'scripts/dev.mjs'))) { throw 'PID reutilizado por outro programa. Nenhum processo foi encerrado.' }
    & taskkill.exe /PID $saved.pid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel encerrar o processo registrado.' }
}
Remove-Item -LiteralPath $pidFile
Write-Host 'ViralFactory Local encerrado. A fila sera recuperada na proxima inicializacao.'
