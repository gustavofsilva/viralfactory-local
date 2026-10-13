param([switch]$Dev)
. (Join-Path $PSScriptRoot 'scripts/common.ps1')
Set-Location -LiteralPath $ProjectRoot
$taskDataDirectory = Get-ProjectDataDirectory
$runtimeDirectory = Join-Path $taskDataDirectory 'runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$pidFile = Join-Path $runtimeDirectory 'server.json'
if (Test-Path -LiteralPath $pidFile) {
    $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($saved.pid)" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.CommandLine.Contains($ProjectRoot)) { Write-Host 'O projeto ja esta iniciado.'; return }
}
if (-not (Test-Path -LiteralPath 'node_modules')) { throw 'Execute .\install.ps1 primeiro.' }
Invoke-ProjectNpm @('run', 'db:setup')
if (-not $Dev) { Invoke-ProjectNpm @('run', 'build') }
$nodePath = (Get-Command node.exe).Source
$devScript = Join-Path $ProjectRoot 'scripts/dev.mjs'
$processArguments = @(('"' + $devScript + '"'))
if (-not $Dev) { $processArguments += '--production' }
$stdout = Join-Path $runtimeDirectory 'server.stdout.log'
$stderr = Join-Path $runtimeDirectory 'server.stderr.log'
$server = Start-Process -FilePath $nodePath -ArgumentList $processArguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
@{ pid = $server.Id; root = $ProjectRoot; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
$apiPortValue = if ($env:API_PORT) { $env:API_PORT } else { '4310' }
$webPortValue = if ($env:WEB_PORT) { $env:WEB_PORT } else { '5173' }
if (Test-Path -LiteralPath '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        if (-not $env:API_PORT -and $line -match '^\s*API_PORT\s*=\s*(\d+)') { $apiPortValue = $Matches[1] }
        if (-not $env:WEB_PORT -and $line -match '^\s*WEB_PORT\s*=\s*(\d+)') { $webPortValue = $Matches[1] }
    }
}
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { throw "O servidor encerrou. Consulte $stderr" }
    try { $response = Invoke-RestMethod -Uri "http://127.0.0.1:$apiPortValue/api/health" -TimeoutSec 2; if ($response.status -eq 'ok') { $healthy = $true; break } } catch {}
}
if (-not $healthy) { throw "O servidor nao respondeu. Consulte $stderr" }
$portValue = if ($Dev) { $webPortValue } else { $apiPortValue }
Write-Host "ViralFactory Local iniciado: http://127.0.0.1:$portValue"
Write-Host 'Para encerrar: .\stop.ps1'
