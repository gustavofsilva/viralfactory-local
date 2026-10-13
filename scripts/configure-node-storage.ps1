param([string]$StorageRoot = 'D:\ViralFactoryLocal')
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$storageDirectory = [System.IO.Path]::GetFullPath($StorageRoot)
if (-not $storageDirectory.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'As dependencias devem ficar no disco D.' }
$localDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory 'node_modules'))
$targetDirectory = [System.IO.Path]::GetFullPath((Join-Path $storageDirectory 'tools/node-dependencies/videomaker/node_modules'))
$backupDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory '.node_modules-before-D'))
if (-not $localDirectory.StartsWith($projectDirectory + '\') -or -not $backupDirectory.StartsWith($projectDirectory + '\') -or -not $targetDirectory.StartsWith($storageDirectory + '\')) { throw 'Caminho de migracao invalido.' }
$existing = Get-Item -LiteralPath $localDirectory -ErrorAction SilentlyContinue
if ($existing -and $existing.LinkType) {
    if ([System.IO.Path]::GetFullPath($existing.Target[0]) -ne $targetDirectory) { throw 'node_modules aponta para outro destino. Verifique antes de migrar.' }
    Write-Host "Dependencias Node no D: $targetDirectory"
    return
}
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
if ($existing) {
    if (Test-Path -LiteralPath $backupDirectory) { throw 'Existe backup anterior das dependencias. Verifique antes de migrar.' }
    & (Join-Path $projectDirectory 'stop.ps1')
    & robocopy.exe $localDirectory $targetDirectory /E /SJ /SL /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) { throw 'Falha ao copiar dependencias para D. Originais preservados.' }
    & robocopy.exe $localDirectory $targetDirectory /E /SJ /SL /L /R:0 /W:0 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ne 0) { throw 'A copia das dependencias nao passou na comparacao. Originais preservados.' }
    Move-Item -LiteralPath $localDirectory -Destination $backupDirectory
}
try { New-Item -ItemType Junction -Path $localDirectory -Target $targetDirectory | Out-Null }
catch {
    if (Test-Path -LiteralPath $backupDirectory) { Move-Item -LiteralPath $backupDirectory -Destination $localDirectory }
    throw
}
Write-Host "Dependencias Node no D: $targetDirectory"
if ($existing) { Write-Host "Backup anterior preservado: $backupDirectory" }
