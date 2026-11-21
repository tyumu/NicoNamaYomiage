@echo off
setlocal
chcp 65001 >nul

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "EXE_PATH=%ROOT_DIR%\bridge\bin\Release\net9.0-windows\NicoNamaAivoiceBridge.exe"
set "EXT_DIR=%ROOT_DIR%\extension"

echo Release ビルドを更新しています...
dotnet build "%ROOT_DIR%\bridge\NicoNamaAivoiceBridge.csproj" -c Release
if errorlevel 1 (
    echo ビルドに失敗しました。NicoNamaAivoiceBridge が起動中の場合はタスクトレイから終了してから再実行してください。
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; " ^
  "$hostName = 'com.niconama.aivoice_bridge'; " ^
  "$exePath = '%EXE_PATH%'; " ^
  "$extDir = [System.IO.Path]::GetFullPath('%EXT_DIR%').TrimEnd('\'); " ^
  "$argId = '%~1'; " ^
  "$ids = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase); " ^
  "if (-not [string]::IsNullOrWhiteSpace($argId)) { $ids.Add($argId.Trim()) | Out-Null }; " ^
  "$roots = @(" ^
  "  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')," ^
  "  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')" ^
  "); " ^
  "foreach ($r in $roots) { " ^
  "  if (-not (Test-Path $r)) { continue }; " ^
  "  Get-ChildItem -Path $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { " ^
  "    foreach ($prefName in @('Preferences', 'Secure Preferences')) { " ^
  "      $prefPath = Join-Path $_.FullName $prefName; " ^
  "      if (-not (Test-Path $prefPath)) { continue }; " ^
  "      try { " ^
  "        $json = Get-Content -Path $prefPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop; " ^
  "        $settings = $json.extensions.settings; " ^
  "        if ($null -eq $settings) { continue }; " ^
  "        foreach ($prop in $settings.PSObject.Properties) { " ^
  "          $p = $prop.Value.path; " ^
  "          if ($p -and ([System.IO.Path]::GetFullPath($p).TrimEnd('\') -ieq $extDir)) { " ^
  "            $ids.Add($prop.Name) | Out-Null; " ^
  "          } " ^
  "        } " ^
  "      } catch {} " ^
  "    } " ^
  "  } " ^
  "}; " ^
  "if ($ids.Count -eq 0) { " ^
  "  Write-Host '拡張機能 ID を自動検出できませんでした。'; " ^
  "  $manual = Read-Host 'chrome://extensions/ (または edge://extensions/) に表示されている ID を入力してください'; " ^
  "  if ([string]::IsNullOrWhiteSpace($manual)) { throw '拡張機能 ID が指定されませんでした。' }; " ^
  "  $ids.Add($manual.Trim()) | Out-Null; " ^
  "} else { " ^
  "  Write-Host ('検出した拡張機能 ID: ' + ($ids -join ', ')); " ^
  "}; " ^
  "$origins = @($ids | ForEach-Object { \"chrome-extension://$_/\" }); " ^
  "$appDir = Join-Path $env:LOCALAPPDATA 'NicoNamaAivoiceBridge'; " ^
  "New-Item -ItemType Directory -Path $appDir -Force | Out-Null; " ^
  "$manifestPath = Join-Path $appDir ($hostName + '.json'); " ^
  "$manifestObj = [ordered]@{ " ^
  "  name = $hostName; " ^
  "  description = 'NicoNama A.I.VOICE Bridge Launcher'; " ^
  "  path = $exePath; " ^
  "  type = 'stdio'; " ^
  "  allowed_origins = $origins " ^
  "}; " ^
  "$jsonText = $manifestObj | ConvertTo-Json -Depth 4; " ^
  "[System.IO.File]::WriteAllText($manifestPath, $jsonText, [System.Text.UTF8Encoding]::new($false)); " ^
  "foreach ($regBase in @('HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts', 'HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts')) { " ^
  "  $regKey = Join-Path $regBase $hostName; " ^
  "  New-Item -Path $regKey -Force | Out-Null; " ^
  "  Set-Item -Path $regKey -Value $manifestPath; " ^
  "}; " ^
  "Write-Host ('登録完了: ' + $manifestPath);"

if errorlevel 1 (
    echo.
    echo 登録に失敗しました。
    pause
    exit /b 1
)

echo.
echo Native Messaging Host の登録が完了しました。ブラウザの拡張機能画面から起動できます。
pause
