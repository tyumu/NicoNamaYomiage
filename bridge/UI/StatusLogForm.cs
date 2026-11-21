using NicoNamaAivoiceBridge.Services;

namespace NicoNamaAivoiceBridge.UI;

public sealed class StatusLogForm : Form
{
    private readonly AiVoiceService _aiVoice;
    private readonly SpeechQueueManager _queue;
    private readonly AppLogger _logger;
    private readonly string _httpUrl;

    private readonly Label _statusValueLabel;
    private readonly Label _versionValueLabel;
    private readonly Label _presetValueLabel;
    private readonly Label _queueValueLabel;
    private readonly Label _endpointValueLabel;
    private readonly TextBox _logBox;

    private bool _allowClose;

    public StatusLogForm(AiVoiceService aiVoice, SpeechQueueManager queue, AppLogger logger, string httpUrl)
    {
        _aiVoice = aiVoice;
        _queue = queue;
        _logger = logger;
        _httpUrl = httpUrl;

        Text = "ニコ生 A.I.VOICE ブリッジ - ステータス / ログ";
        Size = new Size(760, 500);
        MinimumSize = new Size(560, 380);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Yu Gothic UI", 9.5f, FontStyle.Regular);

        var infoPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 4,
            Padding = new Padding(12, 10, 12, 6)
        };
        infoPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        infoPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        infoPanel.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        infoPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));

        _statusValueLabel = CreateValueLabel();
        _versionValueLabel = CreateValueLabel();
        _presetValueLabel = CreateValueLabel();
        _queueValueLabel = CreateValueLabel();
        _endpointValueLabel = CreateValueLabel();

        AddRow(infoPanel, 0, "A.I.VOICE 状態:", _statusValueLabel, "バージョン:", _versionValueLabel);
        AddRow(infoPanel, 1, "現在のプリセット:", _presetValueLabel, "キュー件数 / 設定:", _queueValueLabel);
        AddRow(infoPanel, 2, "HTTP エンドポイント:", _endpointValueLabel, "", new Label { AutoSize = true });

        var buttonPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(10, 2, 10, 8),
            FlowDirection = FlowDirection.LeftToRight
        };

        var reconnectButton = new Button { Text = "再接続", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
        reconnectButton.Click += async (_, _) =>
        {
            reconnectButton.Enabled = false;
            try
            {
                await _aiVoice.ConnectAsync();
            }
            finally
            {
                reconnectButton.Enabled = true;
            }
        };

        var stopButton = new Button { Text = "再生停止・キュー消去", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
        stopButton.Click += async (_, _) =>
        {
            _queue.Clear(null);
            await _aiVoice.RequestStopCurrentAsync(null);
            RefreshStatus();
        };

        _logBox = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = false,
            Font = new Font("Consolas", 9f),
            BackColor = Color.FromArgb(24, 24, 28),
            ForeColor = Color.FromArgb(230, 230, 235)
        };

        var clearLogButton = new Button { Text = "ログ消去", AutoSize = true, Padding = new Padding(8, 3, 8, 3) };
        clearLogButton.Click += (_, _) =>
        {
            _logger.Clear();
            _logBox.Clear();
        };

        buttonPanel.Controls.Add(reconnectButton);
        buttonPanel.Controls.Add(stopButton);
        buttonPanel.Controls.Add(clearLogButton);

        var container = new Panel { Dock = DockStyle.Fill, Padding = new Padding(10, 0, 10, 10) };
        container.Controls.Add(_logBox);

        Controls.Add(container);
        Controls.Add(buttonPanel);
        Controls.Add(infoPanel);

        _aiVoice.StatusChanged += OnStatusChanged;
        _queue.QueueChanged += OnQueueChanged;
        _logger.EntryAdded += OnLogEntryAdded;

        LoadExistingLogs();
        RefreshStatus();
    }

    public void ForceClose()
    {
        _allowClose = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        _aiVoice.StatusChanged -= OnStatusChanged;
        _queue.QueueChanged -= OnQueueChanged;
        _logger.EntryAdded -= OnLogEntryAdded;
        base.OnFormClosing(e);
    }

    private void LoadExistingLogs()
    {
        var lines = _logger.GetSnapshot();
        if (lines.Count > 0)
        {
            _logBox.Text = string.Join(Environment.NewLine, lines) + Environment.NewLine;
            _logBox.SelectionStart = _logBox.TextLength;
            _logBox.ScrollToCaret();
        }
    }

    private void OnStatusChanged(BridgeStatusSnapshot _) => BeginInvokeIfNeeded(RefreshStatus);
    private void OnQueueChanged() => BeginInvokeIfNeeded(RefreshStatus);

    private void OnLogEntryAdded(string line)
    {
        BeginInvokeIfNeeded(() =>
        {
            if (_logBox.Lines.Length > 600)
            {
                var lines = _logger.GetSnapshot();
                _logBox.Text = string.Join(Environment.NewLine, lines) + Environment.NewLine;
            }
            else
            {
                _logBox.AppendText(line + Environment.NewLine);
            }
            _logBox.SelectionStart = _logBox.TextLength;
            _logBox.ScrollToCaret();
        });
    }

    private void RefreshStatus()
    {
        var snap = _aiVoice.GetSnapshot();
        var (maxQueue, maxDelay) = _queue.GetConfig();

        _statusValueLabel.Text = snap.Connected
            ? (snap.IsSpeaking ? $"再生中 ({snap.HostStatus})" : $"接続中 ({snap.HostStatus})")
            : $"未接続 ({snap.HostStatus})";
        _statusValueLabel.ForeColor = snap.Connected ? Color.DarkGreen : Color.Firebrick;
        _versionValueLabel.Text = string.IsNullOrEmpty(snap.Version) ? "-" : snap.Version;
        _presetValueLabel.Text = string.IsNullOrEmpty(snap.CurrentPreset) ? "-" : snap.CurrentPreset;
        _queueValueLabel.Text = $"{_queue.Count} 件 (最大 {maxQueue} 件 / 遅延上限 {maxDelay:0.#} 秒)";
        _endpointValueLabel.Text = _httpUrl;
    }

    private void BeginInvokeIfNeeded(Action action)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }
        try
        {
            if (InvokeRequired)
            {
                BeginInvoke(action);
            }
            else
            {
                action();
            }
        }
        catch (ObjectDisposedException)
        {
            // Ignore during shutdown.
        }
    }

    private static Label CreateValueLabel() => new()
    {
        AutoSize = true,
        Font = new Font("Yu Gothic UI", 9.5f, FontStyle.Bold),
        Margin = new Padding(4, 3, 12, 3)
    };

    private static void AddRow(TableLayoutPanel panel, int row, string label1, Control val1, string label2, Control val2)
    {
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        panel.Controls.Add(new Label { Text = label1, AutoSize = true, Margin = new Padding(0, 3, 4, 3) }, 0, row);
        panel.Controls.Add(val1, 1, row);
        panel.Controls.Add(new Label { Text = label2, AutoSize = true, Margin = new Padding(0, 3, 4, 3) }, 2, row);
        panel.Controls.Add(val2, 3, row);
    }
}
