# ニコ生 A.I.VOICE 読み上げ (NicoNamaYomiage)

ニコニコ生放送（`https://live.nicovideo.jp/watch/*`）のコメントを、ローカルで稼働する Windows タスクトレイブリッジ経由で **A.I.VOICE Editor** に直接読み上げさせるシステムです。

複数タブを同時に開いた場合でも、**タブごとに読み上げの ON / OFF・通常コメント／運営コメントのボイスプリセット・音量・話速を独立して切り替え**られます。

---

## アーキテクチャ

```text
+-------------------------------------------------------+
| Chrome / Edge 拡張機能 (extension/)                   |
|  - inject.js     : fetch(NDGR protobuf) / WS フック   |
|  - content.js    : DOM監視・フィルタ・プレイヤー上バー |
|  - background.js : タブ別状態(storage.session)管理    |
|  - popup.html/js : ポップアップ設定 UI                |
+---------------------------+---------------------------+
                            | HTTP (http://127.0.0.1:50123)
                            v
+-------------------------------------------------------+
| Windows タスクトレイブリッジ (bridge/)                |
|  - BridgeHttpServer   : ローカル HTTP API (CORS対応)  |
|  - SpeechQueueManager : キュー管理・遅延スキップ制御  |
|  - AiVoiceService     : STA スレッド上で再生・声質切替 |
|  - TrayApplication    : タスクトレイ常駐・ログ画面    |
+---------------------------+---------------------------+
                            | COM / WCF Named Pipe
                            v
+-------------------------------------------------------+
| A.I.VOICE Editor (AI.Talk.Editor.Api.dll)             |
+-------------------------------------------------------+
```

### ディレクトリ構成

- `bridge/` — .NET 9 Windows Forms タスクトレイ常駐ローカル HTTP ブリッジ (`NicoNamaAivoiceBridge`)
- `extension/` — Chrome / Edge 用 Manifest V3 拡張機能（ビルド不要の素の HTML / CSS / JavaScript）

---

## 前提条件

- **OS**: Windows 10 / 11
- **A.I.VOICE Editor**: インストール済みかつ起動していること
  - 標準インストール先 `C:\Program Files\AI\AIVoice\AIVoiceEditor\AI.Talk.Editor.Api.dll` を参照しています（環境によりパスが異なる場合は `bridge/NicoNamaAivoiceBridge.csproj` の `<HintPath>` を調整してください）。
- **.NET 9 SDK**（ビルド・実行する場合）
- **Google Chrome** または **Microsoft Edge**（Chromium 系ブラウザ）

---

## 1. ブリッジアプリ (`bridge/`) のビルドと起動

1. 先に **A.I.VOICE Editor** を起動しておきます。
2. リポジトリ直下の **`start-bridge.bat` をダブルクリック**すると起動します（未ビルド時は自動で Release ビルドを実行します）。
   - タスクトレイアイコンの右クリックメニューから **「Windows 起動時に自動実行」** をオンにしておけば、以降は PC 起動時に自動常駐します。

手動でビルド・起動する場合はターミナルから以下を実行します。

```powershell
dotnet build bridge/NicoNamaAivoiceBridge.csproj -c Release
.\bridge\bin\Release\net9.0-windows\NicoNamaAivoiceBridge.exe
```

### オプション・設定ファイル

- **ポート番号の一時変更**: `--port <ポート番号>` 引数で指定できます（例: `NicoNamaAivoiceBridge.exe --port 50123`）。
- **設定ファイル**: 初回起動時に `%LocalAppData%\NicoNamaAivoiceBridge\settings.json` が作成されます。
  - `port`: 待受ポート（既定値 `50123`）
  - `maxQueueSize`: 最大キュー数（既定値 `5`）
  - `maxDelaySeconds`: 遅延スキップ閾値秒数（既定値 `10.0`）
  - `preferredHostName`: 接続対象ホスト名の明示指定（任意）

### タスクトレイメニュー

タスクトレイアイコンを右クリック（ダブルクリックでログ／ステータス画面を表示）すると以下を操作できます。

- A.I.VOICE Editor 接続状態・キュー件数の表示
- **A.I.VOICE Editor に再接続**
- **ログ / ステータスを開く**
- **再生停止・キュー消去**
- **Windows 起動時に自動実行**（`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run` への登録切り替え）
- **終了**

---

## 2. Chrome / Edge 拡張機能 (`extension/`) の読み込み

1. Chrome で `chrome://extensions/`（Edge の場合は `edge://extensions/`）を開きます。
2. 右上の **デベロッパー モード** をオンにします。
3. **パッケージ化されていない拡張機能を読み込む** をクリックします。
4. このリポジトリ内の `extension` フォルダを選択します。

---

## 3. 使い方（タブ別の声質切り替え・設定）

1. A.I.VOICE Editor と `NicoNamaAivoiceBridge` を起動した状態で、ニコニコ生放送の視聴ページ（`https://live.nicovideo.jp/watch/*`）を開きます。
2. 以下のいずれかからタブごとの読み上げを制御できます。
   - **ブラウザ右上の拡張機能アイコン（ポップアップ UI）**:
     - ブリッジ / A.I.VOICE Editor の接続状態確認、再接続、プリセット一覧の更新
     - **現在のタブ設定**: 読み上げ **ON / OFF**、**通常コメント 声質**、**運営コメント 声質**、**音量**、**話速**（`Editorデフォルトを使用` で未指定に戻せます）、**読み上げ停止・キュー消去**、**このタブを消去**
     - **グローバル設定（デフォルト）**: 自動読み上げ開始 (`autoStart`)、デフォルト通常／運営声質、通常／運営コメントの読み上げ対象、URL の「URL省略」置換、最大キュー数・遅延スキップ秒数、ブリッジ URL
   - **動画プレイヤー上部のコンパクト操作バー**:
     - 視聴ページ右上に表示されるバーから、ポップアップを開かずにそのタブの読み上げ ON/OFF、声質プリセット切り替え、停止、折りたたみが行えます。
3. **複数タブ同時視聴**:
   - 各タブの設定は `chrome.storage.session` に `tabId` 単位で保持されるため、タブ A とタブ B で別々のボイスプリセットや ON/OFF 状態を使い分けられます。
   - タブを閉じる、または別サイトへ遷移すると、そのタブのキューはブリッジから自動的にクリアされます。

### 主な安全・快適機能

- **初回バックログ抑制**: ページを開いた直後の過去コメント（`/backward` 取得分や初期 DOM 読み込み分）は読み上げません。
- **運営コマンド整理・システム通知除外**: `/perm` などのコマンド接頭辞を整理し、ニコニ広告・ギフト・エモーション等のシステムメッセージは読み上げ対象外にします。
- **混雑時の遅延スキップ**: キューが `maxQueueSize` を超えた場合や、待機時間が `maxDelaySeconds` を超えた古いコメントを自動で間引き、最新コメントを優先します。

---

## ブリッジ HTTP API 仕様

既定の待受アドレス: `http://127.0.0.1:50123/`（CORS 対応）

| メソッド & パス | 説明 |
| --- | --- |
| `GET /health` | ブリッジおよび A.I.VOICE Editor の接続状態、バージョン、キュー件数を返却 |
| `GET /presets` | 利用可能なボイスプリセット一覧、現在のプリセット、MasterControl 設定を返却 |
| `POST /speak` | コメントをキューへ追加 (`{ tabId, text, voicePreset?, volume?, speed?, timestamp?, isOperator? }`) |
| `POST /config` | スロットリング設定を更新 (`{ maxQueueSize?, maxDelaySeconds? }`) |
| `POST /clear` | 指定タブまたは全キューを消去 (`{ tabId?, stopCurrent? }`) |
| `POST /stop` | 現在の再生を即時停止し、キューを全消去 |
| `POST /connect` | A.I.VOICE Editor への接続・再接続を実行 |
