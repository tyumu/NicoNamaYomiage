param(
    [string]$ExtensionId = ""
)

$ErrorActionPreference = "Stop"
$rootDir = $PSScriptRoot
$csprojPath = Join-Path $rootDir "bridge\NicoNamaAivoiceBridge.csproj"
$exePath = Join-Path $rootDir "bridge\bin\Release\net9.0-windows\NicoNamaAivoiceBridge.exe"
$extDir = [System.IO.Path]::GetFullPath((Join-Path $rootDir "extension")).TrimEnd('\')
$hostName = "com.niconama.aivoice_bridge"

Write-Host "Release ビルドを更新しています..."
& dotnet build $csprojPath -c Release
if ($LASTEXITCODE -ne 0) {
    throw "dotnet build に失敗しました。NicoNamaAivoiceBridge が起動中の場合はタスクトレイから終了してから再実行してください。"
}

if (-not (Test-Path $exePath)) {
    throw "ビルド後の実行ファイルが見つかりません: $exePath"
}

$ids = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
if (-not [string]::IsNullOrWhiteSpace($ExtensionId)) {
    $ids.Add($ExtensionId.Trim()) | Out-Null
}

$roots = @(
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data")
)

foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    Get-ChildItem -Path $r -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        foreach ($prefName in @("Preferences", "Secure Preferences")) {
            $prefPath = Join-Path $_.FullName $prefName
            if (-not (Test-Path $prefPath)) { continue }
            try {
                $json = Get-Content -Path $prefPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
                $settings = $json.extensions.settings
                if ($null -eq $settings) { continue }
                foreach ($prop in $settings.PSObject.Properties) {
                    $p = $prop.Value.path
                    if ($p -and ([System.IO.Path]::GetFullPath($p).TrimEnd('\') -ieq $extDir)) {
                        $ids.Add($prop.Name) | Out-Null
                    }
                }
            } catch {
                # Ignore unreadable profile files
            }
        }
    }
}

if ($ids.Count -eq 0) {
    Write-Host "拡張機能 ID を自動検出できませんでした。"
    $manual = Read-Host "chrome://extensions/ (または edge://extensions/) に表示されている ID を入力してください"
    if ([string]::IsNullOrWhiteSpace($manual)) {
        throw "拡張機能 ID が指定されませんでした。"
    }
    $ids.Add($manual.Trim()) | Out-Null
} else {
    Write-Host ("検出した拡張機能 ID: " + ($ids -join ", "))
}

$origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
$appDir = Join-Path $env:LOCALAPPDATA "NicoNamaAivoiceBridge"
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
$manifestPath = Join-Path $appDir ($hostName + ".json")

$manifestObj = [ordered]@{
    name            = $hostName
    description     = "NicoNama A.I.VOICE Bridge Launcher"
    path            = $exePath
    type            = "stdio"
    allowed_origins = $origins
}
$jsonText = $manifestObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $jsonText, [System.Text.UTF8Encoding]::new($false))

foreach ($regBase in @(
    "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts",
    "HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts"
)) {
    $regKey = Join-Path $regBase $hostName
    New-Item -Path $regKey -Force | Out-Null
    Set-Item -Path $regKey -Value $manifestPath
}

Write-Host ("登録完了: " + $manifestPath)
