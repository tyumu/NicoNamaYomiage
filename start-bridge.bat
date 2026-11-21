@echo off
setlocal
set "EXE_PATH=%~dp0bridge\bin\Release\net9.0-windows\NicoNamaAivoiceBridge.exe"

if not exist "%EXE_PATH%" (
    echo Release build not found. Building NicoNamaAivoiceBridge...
    dotnet build "%~dp0bridge\NicoNamaAivoiceBridge.csproj" -c Release
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

start "" "%EXE_PATH%"
