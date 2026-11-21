using System.Net;
using System.Text;
using System.Text.Json;
using NicoNamaAivoiceBridge.Models;

namespace NicoNamaAivoiceBridge.Services;

public sealed class BridgeHttpServer : IDisposable
{
    private static readonly JsonSerializerOptions JsonReadOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private static readonly JsonSerializerOptions JsonWriteOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly BridgeSettings _settings;
    private readonly AiVoiceService _aiVoice;
    private readonly SpeechQueueManager _queue;
    private readonly AppLogger _logger;
    private readonly CancellationTokenSource _cts = new();
    private HttpListener? _listener;
    private Task? _listenTask;
    private bool _disposed;

    public int Port { get; }
    public string BaseUrl => $"http://127.0.0.1:{Port}/";

    public BridgeHttpServer(
        BridgeSettings settings,
        AiVoiceService aiVoice,
        SpeechQueueManager queue,
        AppLogger logger,
        int? portOverride = null)
    {
        _settings = settings;
        _aiVoice = aiVoice;
        _queue = queue;
        _logger = logger;
        Port = portOverride ?? settings.Port;
    }

    public void Start()
    {
        _listener = CreateListener();
        _listenTask = Task.Run(() => AcceptLoopAsync(_cts.Token));
        _logger.Info($"HTTP server listening on {BaseUrl}");
    }

    private HttpListener CreateListener()
    {
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        listener.Prefixes.Add($"http://localhost:{Port}/");
        try
        {
            listener.Start();
            return listener;
        }
        catch (HttpListenerException)
        {
            // Fall back to 127.0.0.1 only if localhost prefix fails ACL check.
            listener.Close();
            var fallback = new HttpListener();
            fallback.Prefixes.Add($"http://127.0.0.1:{Port}/");
            fallback.Start();
            return fallback;
        }
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _listener is { IsListening: true })
        {
            HttpListenerContext? context;
            try
            {
                context = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (HttpListenerException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.Error($"HTTP accept error: {ex.Message}");
                continue;
            }

            _ = Task.Run(() => HandleRequestAsync(context), ct);
        }
    }

    private async Task HandleRequestAsync(HttpListenerContext context)
    {
        var req = context.Request;
        var res = context.Response;

        ApplyCorsHeaders(res);

        try
        {
            if (string.Equals(req.HttpMethod, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                res.StatusCode = (int)HttpStatusCode.NoContent;
                res.Close();
                return;
            }

            var path = (req.Url?.AbsolutePath ?? "/").TrimEnd('/');
            if (string.IsNullOrEmpty(path))
            {
                path = "/";
            }

            switch (req.HttpMethod.ToUpperInvariant(), path.ToLowerInvariant())
            {
                case ("GET", "/health"):
                    await HandleHealthAsync(res);
                    break;
                case ("GET", "/presets"):
                    await HandlePresetsAsync(res);
                    break;
                case ("POST", "/speak"):
                    await HandleSpeakAsync(req, res);
                    break;
                case ("POST", "/config"):
                    await HandleConfigAsync(req, res);
                    break;
                case ("POST", "/clear"):
                    await HandleClearAsync(req, res);
                    break;
                case ("POST", "/stop"):
                    await HandleStopAsync(res);
                    break;
                case ("POST", "/connect"):
                    await HandleConnectAsync(res);
                    break;
                default:
                    await WriteJsonAsync(res, HttpStatusCode.NotFound, new { ok = false, error = "Not found" });
                    break;
            }
        }
        catch (JsonException ex)
        {
            await WriteJsonAsync(res, HttpStatusCode.BadRequest, new { ok = false, error = $"Invalid JSON: {ex.Message}" });
        }
        catch (Exception ex)
        {
            _logger.Error($"HTTP handler error ({req.HttpMethod} {req.Url?.AbsolutePath}): {ex.Message}");
            try
            {
                await WriteJsonAsync(res, HttpStatusCode.InternalServerError, new { ok = false, error = ex.Message });
            }
            catch
            {
                // Response already closed or aborted.
            }
        }
    }

    private Task HandleHealthAsync(HttpListenerResponse res)
    {
        var snap = _aiVoice.GetSnapshot();
        var (maxQueueSize, maxDelaySeconds) = _queue.GetConfig();
        return WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            connected = snap.Connected,
            hostStatus = snap.HostStatus,
            version = snap.Version,
            queueLength = _queue.Count,
            port = Port,
            maxQueueSize,
            maxDelaySeconds
        });
    }

    private async Task HandlePresetsAsync(HttpListenerResponse res)
    {
        var snap = await _aiVoice.RefreshPresetsAsync().ConfigureAwait(false);
        if (!snap.Connected)
        {
            await WriteJsonAsync(res, HttpStatusCode.ServiceUnavailable, new
            {
                ok = false,
                error = "Not connected to A.I.VOICE Editor",
                presets = Array.Empty<string>(),
                currentPreset = string.Empty,
                masterControl = (object?)null
            }).ConfigureAwait(false);
            return;
        }

        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            presets = snap.Presets,
            currentPreset = snap.CurrentPreset,
            masterControl = snap.MasterControl
        }).ConfigureAwait(false);
    }

    private async Task HandleSpeakAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var body = await ReadJsonBodyAsync<SpeakRequest>(req).ConfigureAwait(false);
        if (body is null || string.IsNullOrWhiteSpace(body.Text))
        {
            await WriteJsonAsync(res, HttpStatusCode.BadRequest, new { ok = false, error = "text is required" }).ConfigureAwait(false);
            return;
        }

        var item = new SpeechQueueItem(
            TabId: body.TabId,
            Text: body.Text.Trim(),
            VoicePreset: string.IsNullOrWhiteSpace(body.VoicePreset) ? null : body.VoicePreset.Trim(),
            Volume: body.Volume,
            Speed: body.Speed,
            ClientTimestamp: body.Timestamp,
            IsOperator: body.IsOperator,
            EnqueuedAtUtc: DateTimeOffset.UtcNow);

        var (droppedCount, queueLength) = _queue.Enqueue(item);
        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            queued = true,
            queueLength,
            droppedCount
        }).ConfigureAwait(false);
    }

    private async Task HandleConfigAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var body = await ReadJsonBodyAsync<ConfigRequest>(req).ConfigureAwait(false) ?? new ConfigRequest();
        if (body.MaxQueueSize.HasValue && body.MaxQueueSize.Value < 1)
        {
            await WriteJsonAsync(res, HttpStatusCode.BadRequest, new { ok = false, error = "maxQueueSize must be >= 1" }).ConfigureAwait(false);
            return;
        }
        if (body.MaxDelaySeconds.HasValue && body.MaxDelaySeconds.Value < 0)
        {
            await WriteJsonAsync(res, HttpStatusCode.BadRequest, new { ok = false, error = "maxDelaySeconds must be >= 0" }).ConfigureAwait(false);
            return;
        }

        var dropped = _queue.UpdateConfig(body.MaxQueueSize, body.MaxDelaySeconds);
        var (maxQueueSize, maxDelaySeconds) = _queue.GetConfig();

        _settings.MaxQueueSize = maxQueueSize;
        _settings.MaxDelaySeconds = maxDelaySeconds;
        try
        {
            _settings.Save();
        }
        catch (Exception ex)
        {
            _logger.Warn($"Failed to persist settings: {ex.Message}");
        }

        _logger.Info($"Config updated: maxQueueSize={maxQueueSize}, maxDelaySeconds={maxDelaySeconds}");
        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            maxQueueSize,
            maxDelaySeconds,
            droppedCount = dropped
        }).ConfigureAwait(false);
    }

    private async Task HandleClearAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var body = await ReadOptionalJsonBodyAsync<ClearRequest>(req).ConfigureAwait(false) ?? new ClearRequest();
        var removedCount = _queue.Clear(body.TabId);
        var stoppedCurrent = false;

        if (body.StopCurrent)
        {
            stoppedCurrent = await _aiVoice.RequestStopCurrentAsync(body.TabId).ConfigureAwait(false);
        }

        if (removedCount > 0 || stoppedCurrent)
        {
            _logger.Info($"Cleared queue (tabId={body.TabId?.ToString() ?? "all"}, removed={removedCount}, stoppedCurrent={stoppedCurrent}).");
        }

        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            removedCount,
            stoppedCurrent,
            queueLength = _queue.Count
        }).ConfigureAwait(false);
    }

    private async Task HandleStopAsync(HttpListenerResponse res)
    {
        var removedCount = _queue.Clear(null);
        await _aiVoice.RequestStopCurrentAsync(null).ConfigureAwait(false);
        _logger.Info($"Stopped playback and cleared queue (removed={removedCount}).");

        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            stopped = true,
            removedCount,
            queueLength = _queue.Count
        }).ConfigureAwait(false);
    }

    private async Task HandleConnectAsync(HttpListenerResponse res)
    {
        var (ok, error, snap) = await _aiVoice.ConnectAsync().ConfigureAwait(false);
        if (!ok)
        {
            await WriteJsonAsync(res, HttpStatusCode.ServiceUnavailable, new
            {
                ok = false,
                connected = false,
                hostStatus = snap.HostStatus,
                version = snap.Version,
                error = error ?? "Failed to connect to A.I.VOICE Editor"
            }).ConfigureAwait(false);
            return;
        }

        await WriteJsonAsync(res, HttpStatusCode.OK, new
        {
            ok = true,
            connected = true,
            hostStatus = snap.HostStatus,
            version = snap.Version
        }).ConfigureAwait(false);
    }

    private static void ApplyCorsHeaders(HttpListenerResponse res)
    {
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Accept";
        res.Headers["Access-Control-Allow-Private-Network"] = "true";
        res.Headers["Access-Control-Max-Age"] = "86400";
    }

    private static async Task<T?> ReadJsonBodyAsync<T>(HttpListenerRequest req)
    {
        using var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8);
        var text = await reader.ReadToEndAsync().ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text))
        {
            return default;
        }
        return JsonSerializer.Deserialize<T>(text, JsonReadOptions);
    }

    private static async Task<T?> ReadOptionalJsonBodyAsync<T>(HttpListenerRequest req)
    {
        if (!req.HasEntityBody)
        {
            return default;
        }
        return await ReadJsonBodyAsync<T>(req).ConfigureAwait(false);
    }

    private static async Task WriteJsonAsync(HttpListenerResponse res, HttpStatusCode status, object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonWriteOptions);
        var bytes = Encoding.UTF8.GetBytes(json);
        res.StatusCode = (int)status;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        res.Close();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _cts.Cancel();
        try
        {
            _listener?.Stop();
            _listener?.Close();
        }
        catch
        {
            // Ignore shutdown exceptions.
        }
        try
        {
            _listenTask?.Wait(1000);
        }
        catch
        {
            // Ignore shutdown exceptions.
        }
        _cts.Dispose();
    }
}
