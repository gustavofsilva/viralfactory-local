param([string]$StorageRoot = 'D:\ViralFactoryLocal', [switch]$SkipOllama, [switch]$SkipPython)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$resolvedRoot = [System.IO.Path]::GetFullPath($StorageRoot)
if (-not $resolvedRoot.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'As ferramentas desta instalacao devem ficar no disco D.' }
$toolsDirectory = Join-Path $resolvedRoot 'tools'
$downloadsDirectory = Join-Path $resolvedRoot 'downloads'
$tempDirectory = Join-Path $resolvedRoot 'tmp'
foreach ($directory in @($resolvedRoot, $toolsDirectory, $downloadsDirectory, $tempDirectory, (Join-Path $resolvedRoot 'data/models/piper'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$env:TEMP = $tempDirectory
$env:TMP = $tempDirectory
$env:PIP_CACHE_DIR = Join-Path $resolvedRoot 'cache/pip'
function Download-File {
    param([string]$Url, [string]$Target)
    if (-not (Test-Path -LiteralPath $Target)) {
        Write-Host "Baixando $([System.IO.Path]::GetFileName($Target)) para o disco D..."
        & curl.exe --fail --location --retry 3 --connect-timeout 20 --max-time 1800 --speed-limit 10000 --speed-time 60 --silent --show-error --output ($Target + '.part') $Url
        if ($LASTEXITCODE -ne 0) { throw "Falha no download: $Url" }
        Move-Item -LiteralPath ($Target + '.part') -Destination $Target
    }
}
if (-not $SkipOllama) {
    $ollamaDirectory = Join-Path $toolsDirectory 'ollama'
    if (-not (Test-Path -LiteralPath (Join-Path $ollamaDirectory 'ollama.exe'))) {
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ollama/ollama/releases/latest'
        $asset = $release.assets | Where-Object { $_.name -eq 'ollama-windows-amd64.zip' } | Select-Object -First 1
        if (-not $asset) { throw 'Ollama nao publicou o pacote portatil esperado.' }
        $archive = Join-Path $downloadsDirectory ('ollama-' + $release.tag_name + '.zip')
        Download-File $asset.browser_download_url $archive
        if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
            $expected = $asset.digest.Substring(7)
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA256 do Ollama nao corresponde ao release oficial.' }
        }
        Write-Host 'Extraindo Ollama portatil no disco D...'
        Expand-Archive -LiteralPath $archive -DestinationPath $ollamaDirectory -Force
        @{version=$release.tag_name;source=$asset.browser_download_url;sha256=$asset.digest;installedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ollamaDirectory 'installation.json') -Encoding UTF8
    }
}
$ffmpegDirectory = Join-Path $toolsDirectory 'ffmpeg'
if (-not (Test-Path -LiteralPath (Join-Path $ffmpegDirectory 'bin/ffmpeg.exe'))) {
    $archive = Join-Path $downloadsDirectory 'ffmpeg-release-essentials.zip'
    Download-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $archive
    $hashFile = Join-Path $downloadsDirectory 'ffmpeg-release-essentials.zip.sha256'
    Download-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256' $hashFile
    $hashText = Get-Content -LiteralPath $hashFile -Raw
    $expected = [regex]::Match($hashText, '[a-fA-F0-9]{64}').Value.ToLowerInvariant()
    if (-not $expected -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA256 do FFmpeg nao corresponde ao publicado.' }
    $expanded = Join-Path $toolsDirectory 'ffmpeg-expanded'
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
    $package = Get-ChildItem -LiteralPath $expanded -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/ffmpeg.exe') } | Select-Object -First 1
    if (-not $package) { throw 'Pacote FFmpeg sem executavel esperado.' }
    $sourcePath = [System.IO.Path]::GetFullPath($package.FullName)
    $destinationPath = [System.IO.Path]::GetFullPath($ffmpegDirectory)
    if (-not $sourcePath.StartsWith($resolvedRoot + '\') -or -not $destinationPath.StartsWith($resolvedRoot + '\')) { throw 'Movimentacao fora da pasta de instalacao.' }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
}
$voiceDirectory = Join-Path $resolvedRoot 'data/models/piper'
$voiceBaseUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/'
foreach ($name in @('pt_BR-faber-medium.onnx', 'pt_BR-faber-medium.onnx.json', 'MODEL_CARD')) { Download-File ($voiceBaseUrl + $name) (Join-Path $voiceDirectory $name) }
@{id='pt_BR-faber-medium';source=$voiceBaseUrl;modelCard='https://huggingface.co/rhasspy/piper-voices/blob/main/pt/pt_BR/faber/medium/MODEL_CARD';datasetLicense='CC0';engineLicense='GPL-3.0';acquiredAt=(Get-Date).ToString('o');sha256=(Get-FileHash -LiteralPath (Join-Path $voiceDirectory 'pt_BR-faber-medium.onnx') -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $voiceDirectory 'license.json') -Encoding UTF8
if (-not $SkipPython) {
    $pythonDirectory = Join-Path $toolsDirectory 'python'
    $pythonExecutable = Join-Path $pythonDirectory 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $pythonExecutable)) { & python -m venv $pythonDirectory; if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar ambiente Python local.' } }
    & $pythonExecutable -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar pip local.' }
    $requirementsPath = Join-Path $PSScriptRoot '../workers/media/requirements.lock.txt'
    if (-not (Test-Path -LiteralPath $requirementsPath)) { $requirementsPath = Join-Path $PSScriptRoot '../workers/media/requirements.txt' }
    & $pythonExecutable -m pip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) { throw 'Falha na instalacao das dependencias de midia.' }
}
Write-Host "Ferramentas locais configuradas em $resolvedRoot"
