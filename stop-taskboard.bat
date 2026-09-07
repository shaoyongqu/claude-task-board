@echo off
setlocal
title Claude Task Board - Stop
cd /d "%~dp0"

echo Stopping Claude Task Board (ports 47823 / 5173) ...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 47823,5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
echo Done.
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
