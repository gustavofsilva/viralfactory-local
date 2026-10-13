param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'ViralFactory Local.lnk'
if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    Write-Host 'Inicializacao automatica removida. O aplicativo ainda pode ser iniciado por start.ps1.'
    return
}
$entryScript = Join-Path $PSScriptRoot 'start.ps1'
if (-not (Test-Path -LiteralPath $entryScript)) { throw 'start.ps1 nao encontrado.' }
$taskShell = New-Object -ComObject WScript.Shell
$shortcut = $taskShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $entryScript + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Agente local ViralFactory: iniciar ao entrar no Windows.'
$shortcut.Save()
Write-Host "Inicializacao no login do Windows configurada: $shortcutPath"
Write-Host 'O computador precisa estar ligado. Para desfazer: .\install-agent-autostart.ps1 -Remove'
