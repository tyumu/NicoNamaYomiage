using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using NicoNamaAivoiceBridge.Services;

namespace NicoNamaAivoiceBridge.UI;

public sealed class TrayApplicationContext : ApplicationContext
{
    private readonly AiVoiceService _aiVoice;
    private readonly BridgeHttpServer _httpServer;
    private readonly SpeechQueueManager _queue;
    private readonly AppLogger _logger;
    private readonly SynchronizationContext _uiContext;

    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _startupMenuItem;
    private readonly Icon _connectedIcon;
    private readonly Icon _disconnectedIcon;
    private readonly Icon _speakingIcon;

    private StatusLogForm? _statusLogForm;
    private bool _exited;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    public TrayApplicationContext(
        AiVoiceService aiVoice,
        BridgeHttpServer httpServer,
        SpeechQueueManager queue,
        AppLogger logger)
    {
        _aiVoice = aiVoice;
        _httpServer = httpServer;
        _queue = queue;
        _logger = logger;
        _uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();

        _connectedIcon = CreateStatusIcon(Color.FromArgb(34, 168, 108));
        _disconnectedIcon = CreateStatusIcon(Color.FromArgb(145, 145, 155));
        _speakingIcon = CreateStatusIcon(Color.FromArgb(46, 134, 222));

        _statusMenuItem = new ToolStripMenuItem("状態: 確認中...") { Enabled = false };
        var reconnectItem = new ToolStripMenuItem("A.I.VOICE Editor に再接続", null, async (_, _) =>
        {
            await _aiVoice.ConnectAsync();
        });
        var openLogItem = new ToolStripMenuItem("ログ / ステータスを開く", null, (_, _) => ShowStatusLogWindow());
        var stopItem = new ToolStripMenuItem("再生停止・キュー消去", null, async (_, _) =>
        {
            _queue.Clear(null);
            await _aiVoice.RequestStopCurrentAsync(null);
        });

        _startupMenuItem = new ToolStripMenuItem("Windows 起動時に自動実行")
        {
            Checked = StartupManager.IsEnabled()
        };
        _startupMenuItem.Click += (_, _) => ToggleStartup();

        var exitItem = new ToolStripMenuItem("終了", null, (_, _) => ExitApplication());

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(reconnectItem);
        menu.Items.Add(openLogItem);
        menu.Items.Add(stopItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_startupMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        _notifyIcon = new NotifyIcon
        {
            Icon = _disconnectedIcon,
            Text = "ニコ生 A.I.VOICE ブリッジ",
            ContextMenuStrip = menu,
            Visible = true
        };
        _notifyIcon.DoubleClick += (_, _) => ShowStatusLogWindow();

        _aiVoice.StatusChanged += OnStatusChanged;
        _queue.QueueChanged += OnQueueChanged;

        UpdateTrayUi(_aiVoice.GetSnapshot());
    }

    private void OnStatusChanged(BridgeStatusSnapshot snapshot)
    {
        _uiContext.Post(_ => UpdateTrayUi(snapshot), null);
    }

    private void OnQueueChanged()
    {
        _uiContext.Post(_ => UpdateTrayUi(_aiVoice.GetSnapshot()), null);
    }

    private void UpdateTrayUi(BridgeStatusSnapshot snapshot)
    {
        if (_exited)
        {
            return;
        }

        var queueCount = _queue.Count;
        if (snapshot.Connected)
        {
            _notifyIcon.Icon = snapshot.IsSpeaking ? _speakingIcon : _connectedIcon;
            var statusLabel = snapshot.IsSpeaking ? "再生中" : "接続中";
            _statusMenuItem.Text = $"状態: {statusLabel} (v{snapshot.Version} / キュー {queueCount})";
            _notifyIcon.Text = TruncateTrayText($"ニコ生 A.I.VOICE ブリッジ - {statusLabel} (キュー {queueCount})");
        }
        else
        {
            _notifyIcon.Icon = _disconnectedIcon;
            _statusMenuItem.Text = $"状態: 未接続 ({snapshot.HostStatus} / キュー {queueCount})";
            _notifyIcon.Text = TruncateTrayText($"ニコ生 A.I.VOICE ブリッジ - 未接続 ({snapshot.HostStatus})");
        }
    }

    private void ShowStatusLogWindow()
    {
        if (_statusLogForm is null || _statusLogForm.IsDisposed)
        {
            _statusLogForm = new StatusLogForm(_aiVoice, _queue, _logger, _httpServer.BaseUrl);
        }

        if (!_statusLogForm.Visible)
        {
            _statusLogForm.Show();
        }
        if (_statusLogForm.WindowState == FormWindowState.Minimized)
        {
            _statusLogForm.WindowState = FormWindowState.Normal;
        }
        _statusLogForm.Activate();
    }

    private void ToggleStartup()
    {
        try
        {
            var next = !StartupManager.IsEnabled();
            var actual = StartupManager.SetEnabled(next);
            _startupMenuItem.Checked = actual;
            _logger.Info($"Windows startup auto-run {(actual ? "enabled" : "disabled")}.");
        }
        catch (Exception ex)
        {
            _logger.Error($"Failed to toggle startup auto-run: {ex.Message}");
            MessageBox.Show(
                $"自動起動の設定に失敗しました:\n{ex.Message}",
                "ニコ生 A.I.VOICE ブリッジ",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private void ExitApplication()
    {
        if (_exited)
        {
            return;
        }
        _exited = true;

        _aiVoice.StatusChanged -= OnStatusChanged;
        _queue.QueueChanged -= OnQueueChanged;

        _statusLogForm?.ForceClose();
        _statusLogForm?.Dispose();

        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();

        _httpServer.Dispose();
        _aiVoice.Dispose();

        DestroyIcon(_connectedIcon.Handle);
        DestroyIcon(_disconnectedIcon.Handle);
        DestroyIcon(_speakingIcon.Handle);
        _connectedIcon.Dispose();
        _disconnectedIcon.Dispose();
        _speakingIcon.Dispose();

        ExitThread();
    }

    private static string TruncateTrayText(string text) =>
        text.Length <= 63 ? text : text[..63];

    private static Icon CreateStatusIcon(Color accentColor)
    {
        using var bmp = new Bitmap(32, 32);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(Color.Transparent);

        using var bgBrush = new SolidBrush(Color.FromArgb(32, 36, 44));
        g.FillEllipse(bgBrush, 1, 1, 30, 30);

        using var ringPen = new Pen(accentColor, 3f);
        g.DrawEllipse(ringPen, 3, 3, 26, 26);

        using var dotBrush = new SolidBrush(accentColor);
        g.FillEllipse(dotBrush, 10, 10, 12, 12);

        var hIcon = bmp.GetHicon();
        return Icon.FromHandle(hIcon);
    }
}
