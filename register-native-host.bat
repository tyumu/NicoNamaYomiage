@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-native-host.ps1" %*
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo.
pause
