@echo off
setlocal
title Claude Task Board - Prod
cd /d "%~dp0"

echo [1/4] Releasing port 47823 (server) ...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 47823 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

if not exist "dist\web\index.html" (
  echo [2/4] dist/web missing - building web assets ...
  call npm run build:web || goto :fail
) else (
  echo [2/4] dist/web found.
)

echo [3/4] Browser will open at http://127.0.0.1:47823 shortly ...
start "" /b cmd /c "%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul && start http://127.0.0.1:47823"

echo [4/4] Starting server (Ctrl+C to stop, or run stop-taskboard.bat) ...
call npm start
pause
exit /b 0

:fail
echo Build failed - aborting.
pause
exit /b 1
