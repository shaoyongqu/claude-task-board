@echo off
setlocal
title Claude Task Board - Dev
cd /d "%~dp0"

echo [1/3] Releasing ports 47823 (server) / 5173 (web) ...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 47823,5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

echo [2/3] Browser will open at http://127.0.0.1:5173 shortly ...
start "" /b cmd /c "%SystemRoot%\System32\timeout.exe /t 3 /nobreak >nul && start http://127.0.0.1:5173"

echo [3/3] Starting dev servers (Ctrl+C to stop, or run stop-taskboard.bat) ...
call npm run dev
pause
