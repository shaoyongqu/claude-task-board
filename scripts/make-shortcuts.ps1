$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$root = Split-Path -Parent $PSScriptRoot

$start = $ws.CreateShortcut("$desktop\任务看板-启动.lnk")
$start.TargetPath = "$root\start-taskboard.bat"
$start.WorkingDirectory = $root
$start.Description = 'Restart Claude Task Board (dev)'
$start.Save()

$stop = $ws.CreateShortcut("$desktop\任务看板-停止.lnk")
$stop.TargetPath = "$root\stop-taskboard.bat"
$stop.WorkingDirectory = $root
$stop.Description = 'Stop Claude Task Board'
$stop.Save()

Write-Host "OK: $desktop"
