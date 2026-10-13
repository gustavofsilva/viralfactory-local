param([string]$StorageRoot = 'D:\ViralFactoryLocal')
. (Join-Path $PSScriptRoot 'common.ps1')
$resolvedRoot = [System.IO.Path]::GetFullPath($StorageRoot)
if (-not $resolvedRoot.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'O armazenamento desta configuracao deve ficar no disco D.' }
$oldDataDirectory = Get-ProjectDataDirectory
if ($oldDataDirectory -ne (Join-Path $resolvedRoot 'data')) {
    & (Join-Path $ProjectRoot 'stop.ps1')
    $destination = Join-Path $resolvedRoot 'data'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    if (Test-Path -LiteralPath $oldDataDirectory) {
        foreach ($entry in Get-ChildItem -LiteralPath $oldDataDirectory -Force) {
            if ($entry.Name -eq 'models') { continue }
            Copy-Item -LiteralPath $entry.FullName -Destination $destination -Recurse -Force
        }
        $previousDatabase = Join-Path $oldDataDirectory 'viralfactory.db'
        $newDatabase = Join-Path $destination 'viralfactory.db'
        if (Test-Path -LiteralPath $previousDatabase) {
            if ((Get-FileHash -LiteralPath $previousDatabase).Hash -ne (Get-FileHash -LiteralPath $newDatabase).Hash) { throw 'A copia do banco nao corresponde ao original.' }
        }
    }
}
$configuration = [ordered]@{
    DATA_DIR = (Join-Path $resolvedRoot 'data').Replace('\','/')
    TOOLS_DIR = (Join-Path $resolvedRoot 'tools').Replace('\','/')
    OLLAMA_URL = 'http://127.0.0.1:11434'
    OLLAMA_MODELS = (Join-Path $resolvedRoot 'data/models/ollama').Replace('\','/')
    OLLAMA_TIMEOUT_MS = '240000'
    FFMPEG_PATH = (Join-Path $resolvedRoot 'tools/ffmpeg/bin/ffmpeg.exe').Replace('\','/')
    FFPROBE_PATH = (Join-Path $resolvedRoot 'tools/ffmpeg/bin/ffprobe.exe').Replace('\','/')
    PYTHON_PATH = (Join-Path $resolvedRoot 'tools/python/Scripts/python.exe').Replace('\','/')
    PIPER_MODEL = (Join-Path $resolvedRoot 'data/models/piper/pt_BR-faber-medium.onnx').Replace('\','/')
    WHISPER_MODEL = (Join-Path $resolvedRoot 'data/models/whisper/small').Replace('\','/')
    HF_HOME = (Join-Path $resolvedRoot 'cache/huggingface').Replace('\','/')
    PIP_CACHE_DIR = (Join-Path $resolvedRoot 'cache/pip').Replace('\','/')
    TEMP = (Join-Path $resolvedRoot 'tmp').Replace('\','/')
    TMP = (Join-Path $resolvedRoot 'tmp').Replace('\','/')
}
$envFile = Join-Path $ProjectRoot '.env'
$lines = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile) } else { @(Get-Content -LiteralPath (Join-Path $ProjectRoot '.env.example')) }
foreach ($key in $configuration.Keys) {
    $pattern = '^' + [regex]::Escape($key) + '='
    $value = $key + '=' + $configuration[$key]
    if ($lines | Where-Object { $_ -match $pattern }) { $lines = @($lines | ForEach-Object { if ($_ -match $pattern) { $value } else { $_ } }) } else { $lines += $value }
}
$lines | Set-Content -LiteralPath $envFile -Encoding UTF8
foreach ($folder in @('tmp', 'data', 'data/models/ollama', 'data/models/whisper', 'cache/huggingface', 'cache/pip')) { New-Item -ItemType Directory -Path (Join-Path $resolvedRoot $folder) -Force | Out-Null }
Write-Host "Dados e ferramentas configurados no disco D: $resolvedRoot"
Write-Host 'A copia original dos dados foi preservada como backup.'
