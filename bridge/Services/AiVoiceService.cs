using System.Collections.Concurrent;
using System.ServiceModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using AI.Talk.Editor.Api;
using NicoNamaAivoiceBridge.Models;

namespace NicoNamaAivoiceBridge.Services;

public sealed record BridgeStatusSnapshot(
    bool Connected,
    string HostStatus,
    string Version,
    string CurrentPreset,
    string[] Presets,
    JsonNode? MasterControl,
    bool IsSpeaking,
    long? CurrentTabId);

public sealed class AiVoiceService : IDisposable
{
    private readonly SpeechQueueManager _queue;
    private readonly AppLogger _logger;
    private readonly string? _preferredHostName;

    private readonly CancellationTokenSource _shutdownCts = new();
    private readonly ConcurrentQueue<Action> _staActions = new();
    private readonly AutoResetEvent _staWakeEvent = new(false);
    private readonly ManualResetEventSlim _playbackStopSignal = new(false);
    private readonly Thread _staThread;
    private readonly object _snapshotLock = new();

    private TtsControl? _tts;
    private ChannelFactory<IRemoteService>? _channelFactory;
    private IRemoteService? _remote;
    private bool _usingDirectChannel;
    private string? _initializedHostName;

    private BridgeStatusSnapshot _snapshot = new(
        Connected: false,
        HostStatus: nameof(HostStatus.NotRunning),
        Version: string.Empty,
        CurrentPreset: string.Empty,
        Presets: [],
        MasterControl: null,
        IsSpeaking: false,
        CurrentTabId: null);

    private volatile bool _stopCurrentRequested;
    private long _stopTargetTabId = -1; // -1 means stop regardless of tabId; accessed via Interlocked
    private bool _disposed;

    public event Action<BridgeStatusSnapshot>? StatusChanged;

    public AiVoiceService(SpeechQueueManager queue, AppLogger logger, string? preferredHostName = null)
    {
        _queue = queue;
        _logger = logger;
        _preferredHostName = preferredHostName;

        _staThread = new Thread(StaLoop)
        {
            Name = "AiVoiceStaWorker",
            IsBackground = true
        };
        _staThread.SetApartmentState(ApartmentState.STA);
        _staThread.Start();
    }

    public BridgeStatusSnapshot GetSnapshot()
    {
        lock (_snapshotLock)
        {
            return _snapshot;
        }
    }

    public Task<(bool Ok, string? Error, BridgeStatusSnapshot Snapshot)> ConnectAsync(int timeoutMs = 5000)
    {
        return RunOnStaAsync(() =>
        {
            var (ok, error) = TryConnectInternal(allowLogError: true);
            if (ok)
            {
                RefreshMetadataInternal();
            }
            return (ok, error, GetSnapshot());
        }, timeoutMs);
    }

    public Task<BridgeStatusSnapshot> RefreshPresetsAsync(int timeoutMs = 3000)
    {
        var snap = GetSnapshot();
        if (!snap.Connected || snap.IsSpeaking)
        {
            return Task.FromResult(snap);
        }

        return RunOnStaAsync(() =>
        {
            try
            {
                RefreshMetadataInternal();
            }
            catch (Exception ex) when (IsCommunicationError(ex))
            {
                HandleDisconnect("Connection lost while refreshing presets", ex);
            }
            catch (Exception ex)
            {
                _logger.Warn($"Failed to refresh presets: {ex.Message}");
            }
            return GetSnapshot();
        }, timeoutMs);
    }

    public Task<bool> RequestStopCurrentAsync(long? tabId = null, int timeoutMs = 3000)
    {
        var snap = GetSnapshot();
        if (!snap.IsSpeaking)
        {
            return Task.FromResult(false);
        }

        if (tabId.HasValue && snap.CurrentTabId != tabId.Value)
        {
            return Task.FromResult(false);
        }

        Interlocked.Exchange(ref _stopTargetTabId, tabId ?? -1);
        _stopCurrentRequested = true;
        _playbackStopSignal.Set();

        return RunOnStaAsync(() =>
        {
            if (!GetSnapshot().IsSpeaking)
            {
                return false;
            }
            try
            {
                if (IsConnectedInternal())
                {
                    StopCore();
                }
                return true;
            }
            catch (Exception ex) when (IsCommunicationError(ex))
            {
                HandleDisconnect("Connection lost during stop", ex);
                return false;
            }
            catch
            {
                return false;
            }
        }, timeoutMs);
    }

    private Task<T> RunOnStaAsync<T>(Func<T> func, int timeoutMs)
    {
        if (_disposed || _shutdownCts.IsCancellationRequested)
        {
            return Task.FromCanceled<T>(new CancellationToken(true));
        }

        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        _staActions.Enqueue(() =>
        {
            try
            {
                tcs.TrySetResult(func());
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
        });
        _staWakeEvent.Set();
        _queue.Signal();

        if (timeoutMs > 0)
        {
            var timeoutCts = new CancellationTokenSource(timeoutMs);
            var reg = timeoutCts.Token.Register(() =>
                tcs.TrySetException(new TimeoutException("A.I.VOICE STA operation timed out.")));
            tcs.Task.ContinueWith(_ =>
            {
                reg.Dispose();
                timeoutCts.Dispose();
            }, TaskScheduler.Default);
        }

        return tcs.Task;
    }

    private void StaLoop()
    {
        _logger.Info("A.I.VOICE STA worker started.");
        _tts = new TtsControl();

        // Attempt initial auto-connect without disturbing user if editor isn't running.
        TryAutoConnectOnStartup();

        var lastHealthCheck = DateTimeOffset.UtcNow;
        var lastReconnectAttempt = DateTimeOffset.UtcNow;

        while (!_shutdownCts.IsCancellationRequested)
        {
            try
            {
                DrainStaActions();

                var now = DateTimeOffset.UtcNow;
                if (!IsConnectedInternal())
                {
                    if ((now - lastReconnectAttempt).TotalSeconds >= 4.0)
                    {
                        lastReconnectAttempt = now;
                        TryAutoReconnectTick();
                    }
                }
                else
                {
                    // Process queued speech items when connected.
                    var item = _queue.TryDequeueNext();
                    if (item is not null)
                    {
                        SpeakItemInternal(item);
                        lastHealthCheck = DateTimeOffset.UtcNow;
                        continue;
                    }

                    if ((now - lastHealthCheck).TotalSeconds >= 2.5)
                    {
                        lastHealthCheck = now;
                        CheckConnectionHealthInternal();
                    }
                }

                // Wait for new queue items, STA commands, or shutdown.
                WaitHandle.WaitAny([_staWakeEvent, _queue.ItemAvailableWaitHandle, _shutdownCts.Token.WaitHandle], 200);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.Error($"Unexpected error in A.I.VOICE STA loop: {ex.Message}");
                Thread.Sleep(500);
            }
        }

        CleanupConnection();
        _logger.Info("A.I.VOICE STA worker stopped.");
    }

    private void DrainStaActions()
    {
        while (_staActions.TryDequeue(out var action))
        {
            action();
        }
    }

    private void TryAutoConnectOnStartup()
    {
        var (ok, error) = TryConnectInternal(allowLogError: false);
        if (ok)
        {
            RefreshMetadataInternal();
            var snap = GetSnapshot();
            _logger.Info($"Connected to A.I.VOICE Editor {snap.Version} (Preset: {snap.CurrentPreset}).");
        }
        else if (!string.IsNullOrEmpty(error))
        {
            _logger.Info($"Initial A.I.VOICE connection pending: {error}");
        }
    }

    private void TryAutoReconnectTick()
    {
        if (_tts is null)
        {
            return;
        }

        try
        {
            var hostName = ResolveHostName();
            if (hostName is null)
            {
                UpdateSnapshot(s => s with { Connected = false, HostStatus = nameof(HostStatus.NotRunning) });
                return;
            }

            if (!_tts.IsInitialized || !string.Equals(_initializedHostName, hostName, StringComparison.Ordinal))
            {
                _tts.Initialize(hostName);
                _initializedHostName = hostName;
            }

            var status = _tts.Status;
            if (status == HostStatus.NotRunning)
            {
                UpdateSnapshot(s => s with { Connected = false, HostStatus = nameof(HostStatus.NotRunning), Version = string.Empty });
                return;
            }

            var (ok, _) = TryConnectInternal(allowLogError: false);
            if (ok)
            {
                RefreshMetadataInternal();
                var snap = GetSnapshot();
                _logger.Info($"Reconnected to A.I.VOICE Editor {snap.Version}.");
            }
        }
        catch
        {
            // Keep silent during background auto-reconnect polling.
        }
    }

    private (bool Ok, string? Error) TryConnectInternal(bool allowLogError)
    {
        if (_tts is null)
        {
            return (false, "TtsControl is not initialized.");
        }

        CleanupConnection();

        try
        {
            var hostName = ResolveHostName();
            if (string.IsNullOrEmpty(hostName))
            {
                UpdateSnapshot(s => s with
                {
                    Connected = false,
                    HostStatus = nameof(HostStatus.NotRunning),
                    Version = string.Empty
                });
                return (false, "No A.I.VOICE Editor host found.");
            }

            if (!_tts.IsInitialized || !string.Equals(_initializedHostName, hostName, StringComparison.Ordinal))
            {
                _tts.Initialize(hostName);
                _initializedHostName = hostName;
            }

            var preStatus = _tts.Status;
            if (preStatus == HostStatus.NotRunning)
            {
                UpdateSnapshot(s => s with
                {
                    Connected = false,
                    HostStatus = nameof(HostStatus.NotRunning),
                    Version = string.Empty
                });
                return (false, "A.I.VOICE Editor is not running.");
            }

            try
            {
                _tts.Connect();
                _usingDirectChannel = false;
            }
            catch (TypeLoadException)
            {
                // AI.Talk.Editor.Api.dll targets .NET Framework System.ServiceModel.NetNamedPipeBinding.
                // On .NET 9, connect directly to the same WCF IRemoteService named-pipe endpoint.
                var binding = new NetNamedPipeBinding(NetNamedPipeSecurityMode.Transport)
                {
                    MaxReceivedMessageSize = 1073741824,
                    MaxBufferSize = 1073741824,
                    OpenTimeout = TimeSpan.FromSeconds(5),
                    SendTimeout = TimeSpan.FromSeconds(10),
                    ReceiveTimeout = TimeSpan.FromSeconds(10),
                    CloseTimeout = TimeSpan.FromSeconds(3)
                };
                var address = new EndpointAddress($"net.pipe://localhost/{hostName}/Default");
                _channelFactory = new ChannelFactory<IRemoteService>(binding, address);
                _remote = _channelFactory.CreateChannel();
                _usingDirectChannel = true;
            }

            var version = GetVersionCore();
            var busy = IsBusyCore();
            UpdateSnapshot(s => s with
            {
                Connected = true,
                HostStatus = busy ? nameof(HostStatus.Busy) : nameof(HostStatus.Idle),
                Version = version
            });
            return (true, null);
        }
        catch (Exception ex)
        {
            CleanupConnection();
            var hostStatus = SafeGetPreConnectStatus();
            UpdateSnapshot(s => s with
            {
                Connected = false,
                HostStatus = hostStatus.ToString(),
                Version = string.Empty
            });
            if (allowLogError)
            {
                _logger.Warn($"Failed to connect to A.I.VOICE Editor: {ex.Message}");
            }
            return (false, ex.Message);
        }
    }

    private string? ResolveHostName()
    {
        if (_tts is null)
        {
            return null;
        }

        var hosts = _tts.GetAvailableHostNames();
        if (hosts is null || hosts.Length == 0)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(_preferredHostName))
        {
            var match = hosts.FirstOrDefault(h => string.Equals(h, _preferredHostName, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                return match;
            }
        }

        return hosts[0];
    }

    private HostStatus SafeGetPreConnectStatus()
    {
        try
        {
            return _tts?.Status ?? HostStatus.NotRunning;
        }
        catch
        {
            return HostStatus.NotRunning;
        }
    }

    private void CheckConnectionHealthInternal()
    {
        try
        {
            var busy = IsBusyCore();
            UpdateSnapshot(s => s with
            {
                Connected = true,
                HostStatus = busy ? nameof(HostStatus.Busy) : nameof(HostStatus.Idle)
            });
        }
        catch (Exception ex) when (IsCommunicationError(ex))
        {
            HandleDisconnect("A.I.VOICE Editor disconnected", ex);
        }
        catch (Exception ex)
        {
            _logger.Warn($"Health check warning: {ex.Message}");
        }
    }

    private void RefreshMetadataInternal()
    {
        if (!IsConnectedInternal())
        {
            return;
        }

        var version = GetVersionCore();
        var busy = IsBusyCore();
        var presets = GetVoicePresetNamesCore();
        var currentPreset = GetCurrentVoicePresetNameCore();
        var masterJson = GetMasterControlCore();
        JsonNode? masterNode = null;
        try
        {
            masterNode = JsonNode.Parse(masterJson);
        }
        catch
        {
            // Keep null if masterControl JSON couldn't be parsed.
        }

        UpdateSnapshot(s => s with
        {
            Connected = true,
            HostStatus = busy ? nameof(HostStatus.Busy) : nameof(HostStatus.Idle),
            Version = version,
            Presets = presets,
            CurrentPreset = currentPreset,
            MasterControl = masterNode
        });
    }

    private void SpeakItemInternal(SpeechQueueItem item)
    {
        _stopCurrentRequested = false;
        Interlocked.Exchange(ref _stopTargetTabId, -1);
        _playbackStopSignal.Reset();

        string? baselineMasterJson = null;
        bool masterModified = false;
        int? originalEditMode = null;

        UpdateSnapshot(s => s with
        {
            IsSpeaking = true,
            CurrentTabId = item.TabId,
            HostStatus = nameof(HostStatus.Busy)
        });

        try
        {
            // If editor is currently busy (e.g., manual playback), wait briefly for it to go idle.
            var waitBusyStart = DateTimeOffset.UtcNow;
            while (IsBusyCore())
            {
                DrainStaActions();
                if (ShouldStopCurrent(item.TabId) || _shutdownCts.IsCancellationRequested)
                {
                    return;
                }
                if ((DateTimeOffset.UtcNow - waitBusyStart).TotalSeconds > 15)
                {
                    _logger.Warn("Timed out waiting for A.I.VOICE Editor to become idle before playback.");
                    break;
                }
                _playbackStopSignal.Wait(50);
            }

            // Ensure Text edit mode so SetText + Play plays the comment text.
            var currentEditMode = GetTextInputFormatCore();
            if (currentEditMode != (int)TextEditMode.Text)
            {
                originalEditMode = currentEditMode;
                SetTextInputFormatCore((int)TextEditMode.Text);
            }

            // Switch voice preset if specified and present.
            if (!string.IsNullOrWhiteSpace(item.VoicePreset))
            {
                var presets = GetVoicePresetNamesCore();
                var matchedPreset = presets.FirstOrDefault(p =>
                    string.Equals(p, item.VoicePreset, StringComparison.Ordinal));
                if (matchedPreset is not null)
                {
                    var currentPreset = GetCurrentVoicePresetNameCore();
                    if (!string.Equals(currentPreset, matchedPreset, StringComparison.Ordinal))
                    {
                        SetCurrentVoicePresetNameCore(matchedPreset);
                        UpdateSnapshot(s => s with { CurrentPreset = matchedPreset });
                    }
                }
                else
                {
                    _logger.Warn($"Requested voice preset \"{item.VoicePreset}\" not found; using current preset.");
                }
            }

            // Capture baseline MasterControl and apply optional per-comment volume/speed overrides.
            baselineMasterJson = GetMasterControlCore();
            if (item.Volume.HasValue || item.Speed.HasValue)
            {
                var node = JsonNode.Parse(baselineMasterJson)?.AsObject();
                if (node is not null)
                {
                    if (item.Volume.HasValue)
                    {
                        node["Volume"] = Math.Clamp(item.Volume.Value, 0.0, 5.0);
                    }
                    if (item.Speed.HasValue)
                    {
                        node["Speed"] = Math.Clamp(item.Speed.Value, 0.5, 4.0);
                    }
                    try
                    {
                        SetMasterControlCore(node.ToJsonString());
                        masterModified = true;
                    }
                    catch (Exception ex) when (!IsCommunicationError(ex))
                    {
                        _logger.Warn($"Failed to apply MasterControl override: {ex.Message}");
                    }
                }
            }

            SetTextCore(item.Text);
            try
            {
                SetTextSelectionStartCore(0);
                SetTextSelectionLengthCore(0);
            }
            catch
            {
                // Selection reset is best-effort.
            }

            long estimatedPlayTimeMs = 0;
            try
            {
                estimatedPlayTimeMs = GetPlayTimeCore();
            }
            catch
            {
                // Non-fatal if GetPlayTime fails before Play.
            }

            _logger.Info($"Speak [tab={item.TabId}{(item.IsOperator ? ",op" : "")}] ({item.VoicePreset ?? "default"}): {item.Text}");
            PlayCore();

            WaitForPlaybackCompletion(item.TabId, estimatedPlayTimeMs);
        }
        catch (Exception ex) when (IsCommunicationError(ex))
        {
            HandleDisconnect("Connection lost during playback", ex);
        }
        catch (Exception ex)
        {
            _logger.Error($"Playback error: {ex.Message}");
        }
        finally
        {
            // Restore baseline MasterControl and TextEditMode even if stopped or errored.
            if (masterModified && baselineMasterJson is not null && IsConnectedInternal())
            {
                try
                {
                    SetMasterControlCore(baselineMasterJson);
                }
                catch (Exception ex)
                {
                    _logger.Warn($"Failed to restore MasterControl baseline: {ex.Message}");
                }
            }

            if (originalEditMode.HasValue && IsConnectedInternal())
            {
                try
                {
                    SetTextInputFormatCore(originalEditMode.Value);
                }
                catch
                {
                    // Ignore restore failure on disconnect.
                }
            }

            _stopCurrentRequested = false;
            Interlocked.Exchange(ref _stopTargetTabId, -1);
            _playbackStopSignal.Reset();

            var stillConnected = IsConnectedInternal();
            var busy = false;
            if (stillConnected)
            {
                try
                {
                    busy = IsBusyCore();
                }
                catch
                {
                    stillConnected = false;
                }
            }

            UpdateSnapshot(s => s with
            {
                IsSpeaking = false,
                CurrentTabId = null,
                Connected = stillConnected,
                HostStatus = stillConnected ? (busy ? nameof(HostStatus.Busy) : nameof(HostStatus.Idle)) : nameof(HostStatus.NotRunning)
            });
        }
    }

    private void WaitForPlaybackCompletion(long tabId, long estimatedPlayTimeMs)
    {
        var start = DateTimeOffset.UtcNow;
        var maxWaitMs = Math.Max(60_000L, estimatedPlayTimeMs + 15_000L);
        bool sawBusy = false;

        while (!_shutdownCts.IsCancellationRequested)
        {
            DrainStaActions();

            if (ShouldStopCurrent(tabId))
            {
                try
                {
                    StopCore();
                }
                catch
                {
                    // Ignore if already stopped or disconnected.
                }
                break;
            }

            bool busy = IsBusyCore();
            if (busy)
            {
                sawBusy = true;
            }
            else
            {
                var elapsedMs = (DateTimeOffset.UtcNow - start).TotalMilliseconds;
                // Wait up to 250ms for A.I.VOICE Editor to transition to Busy after Play().
                if (sawBusy || elapsedMs >= 250)
                {
                    break;
                }
            }

            if ((DateTimeOffset.UtcNow - start).TotalMilliseconds >= maxWaitMs)
            {
                _logger.Warn("Playback wait exceeded safety timeout; continuing queue.");
                break;
            }

            _playbackStopSignal.Wait(50);
        }
    }

    private bool ShouldStopCurrent(long tabId)
    {
        if (!_stopCurrentRequested)
        {
            return false;
        }
        var target = Interlocked.Read(ref _stopTargetTabId);
        return target == -1 || target == tabId;
    }

    private bool IsConnectedInternal()
    {
        if (_usingDirectChannel)
        {
            return _remote is IClientChannel channel && channel.State is CommunicationState.Created or CommunicationState.Opened;
        }
        return _tts is not null && _tts.IsInitialized && _tts.Status is HostStatus.Idle or HostStatus.Busy;
    }

    private void HandleDisconnect(string reason, Exception ex)
    {
        _logger.Warn($"{reason}: {ex.Message}");
        CleanupConnection();
        var status = SafeGetPreConnectStatus();
        UpdateSnapshot(s => s with
        {
            Connected = false,
            HostStatus = status.ToString(),
            Version = string.Empty,
            IsSpeaking = false,
            CurrentTabId = null
        });
    }

    private void CleanupConnection()
    {
        if (_usingDirectChannel)
        {
            if (_remote is IClientChannel channel)
            {
                try
                {
                    if (channel.State == CommunicationState.Faulted)
                    {
                        channel.Abort();
                    }
                    else
                    {
                        channel.Close();
                    }
                }
                catch
                {
                    channel.Abort();
                }
            }
            _remote = null;

            if (_channelFactory is not null)
            {
                try
                {
                    if (_channelFactory.State == CommunicationState.Faulted)
                    {
                        _channelFactory.Abort();
                    }
                    else
                    {
                        _channelFactory.Close();
                    }
                }
                catch
                {
                    _channelFactory.Abort();
                }
            }
            _channelFactory = null;
            _usingDirectChannel = false;
        }
        else if (_tts is not null)
        {
            try
            {
                if (_tts.IsInitialized && _tts.Status is HostStatus.Idle or HostStatus.Busy)
                {
                    _tts.Disconnect();
                }
            }
            catch
            {
                // Ignore disconnect errors during cleanup.
            }
        }
    }

    private static bool IsCommunicationError(Exception ex) =>
        ex is CommunicationException or TimeoutException or ObjectDisposedException;

    private void UpdateSnapshot(Func<BridgeStatusSnapshot, BridgeStatusSnapshot> updater)
    {
        BridgeStatusSnapshot updated;
        lock (_snapshotLock)
        {
            updated = updater(_snapshot);
            _snapshot = updated;
        }
        StatusChanged?.Invoke(updated);
    }

    // Core API wrappers (support both TtsControl and direct WCF IRemoteService fallback on .NET 9)
    private string GetVersionCore() => _usingDirectChannel ? _remote!.GetVersion() : _tts!.Version;
    private bool IsBusyCore() => _usingDirectChannel ? _remote!.IsBusy() : _tts!.Status == HostStatus.Busy;
    private int GetTextInputFormatCore() => _usingDirectChannel ? _remote!.GetTextInputFormat() : (int)_tts!.TextEditMode;
    private void SetTextInputFormatCore(int mode)
    {
        if (_usingDirectChannel) _remote!.SetTextInputFormat(mode);
        else _tts!.TextEditMode = (TextEditMode)mode;
    }
    private void SetTextCore(string text)
    {
        if (_usingDirectChannel) _remote!.SetText(text);
        else _tts!.Text = text;
    }
    private void SetTextSelectionStartCore(int pos)
    {
        if (_usingDirectChannel) _remote!.SetTextSelectionStart(pos);
        else _tts!.TextSelectionStart = pos;
    }
    private void SetTextSelectionLengthCore(int len)
    {
        if (_usingDirectChannel) _remote!.SetTextSelectionLength(len);
        else _tts!.TextSelectionLength = len;
    }
    private void PlayCore()
    {
        if (_usingDirectChannel) _remote!.Play();
        else _tts!.Play();
    }
    private void StopCore()
    {
        if (_usingDirectChannel) _remote!.Stop();
        else _tts!.Stop();
    }
    private long GetPlayTimeCore() => _usingDirectChannel ? _remote!.GetPlayTime() : _tts!.GetPlayTime();
    private string[] GetVoicePresetNamesCore() => _usingDirectChannel ? _remote!.GetVoicePresetNames() : _tts!.VoicePresetNames;
    private string GetCurrentVoicePresetNameCore() => _usingDirectChannel ? _remote!.GetCurrentVoicePresetName() : _tts!.CurrentVoicePresetName;
    private void SetCurrentVoicePresetNameCore(string preset)
    {
        if (_usingDirectChannel) _remote!.SetCurrentVoicePresetName(preset);
        else _tts!.CurrentVoicePresetName = preset;
    }
    private string GetMasterControlCore() => _usingDirectChannel ? _remote!.GetMasterControl() : _tts!.MasterControl;
    private void SetMasterControlCore(string json)
    {
        if (_usingDirectChannel) _remote!.SetMasterControl(json);
        else _tts!.MasterControl = json;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _shutdownCts.Cancel();
        _playbackStopSignal.Set();
        _staWakeEvent.Set();
        _queue.Signal();

        if (!_staThread.Join(3000))
        {
            _logger.Warn("STA worker thread did not exit within timeout.");
        }

        _playbackStopSignal.Dispose();
        _staWakeEvent.Dispose();
        _shutdownCts.Dispose();
    }
}
