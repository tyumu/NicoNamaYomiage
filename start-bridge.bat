@echo off
setlocal

set "EDITOR_EXE=C:\Program Files\AI\AIVoice\AIVoiceEditor\AIVoiceEditor.exe"
if not exist "%EDITOR_EXE%" (
    set "EDITOR_EXE=C:\Program Files (x86)\AI\AIVoice\AIVoiceEditor\AIVoiceEditor.exe"
)

tasklist /FI "IMAGENAME eq AIVoiceEditor.exe" 2>NUL | find /I "AIVoiceEditor.exe" >NUL
if errorlevel 1 (
    if exist "%EDITOR_EXE%" (
        start "" "%EDITOR_EXE%"
    ) else (
        echo AIVoiceEditor.exe が見つかりませんでした。手動で起動してください。
    )
)

set "EXE_PATH=%~dp0bridge\bin\Release\net9.0-windows\NicoNamaAivoiceBridge.exe"

if not exist "%EXE_PATH%" (
    echo Release ビルドが見つからないためビルドしています...
    dotnet build "%~dp0bridge\NicoNamaAivoiceBridge.csproj" -c Release
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

start "" "%EXE_PATH%" --quiet
