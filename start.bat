@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8099

echo ========================================
echo   Codex -^> DeepSeek Proxy
echo ========================================
echo.

REM Kill existing process on port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo [CLEAN] Killing PID %%a on port %PORT%...
    taskkill /PID %%a /F 2>nul
    timeout /t 1 /nobreak >nul
)
echo [OK] Port %PORT% is free
echo.

echo Starting proxy... (close this window to stop)
echo ========================================
echo.

node proxy.js

echo.
echo Proxy stopped. Press any key to close...
pause >nul
