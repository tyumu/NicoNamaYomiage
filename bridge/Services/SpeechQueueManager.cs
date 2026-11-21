using NicoNamaAivoiceBridge.Models;

namespace NicoNamaAivoiceBridge.Services;

public sealed class SpeechQueueManager : IDisposable
{
    private readonly object _lock = new();
    private readonly LinkedList<SpeechQueueItem> _queue = new();
    private readonly AutoResetEvent _itemAvailable = new(false);
    private readonly AppLogger _logger;

    private int _maxQueueSize;
    private double _maxDelaySeconds;

    public WaitHandle ItemAvailableWaitHandle => _itemAvailable;

    public SpeechQueueManager(int maxQueueSize, double maxDelaySeconds, AppLogger logger)
    {
        _maxQueueSize = Math.Max(1, maxQueueSize);
        _maxDelaySeconds = Math.Max(0, maxDelaySeconds);
        _logger = logger;
    }

    public event Action? QueueChanged;

    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _queue.Count;
            }
        }
    }

    public (int MaxQueueSize, double MaxDelaySeconds) GetConfig()
    {
        lock (_lock)
        {
            return (_maxQueueSize, _maxDelaySeconds);
        }
    }

    public (int DroppedCount, int QueueLength) Enqueue(SpeechQueueItem item)
    {
        int dropped;
        int length;
        lock (_lock)
        {
            dropped = PurgeExpiredLocked(DateTimeOffset.UtcNow);
            _queue.AddLast(item);

            while (_queue.Count > _maxQueueSize)
            {
                var oldest = _queue.First!.Value;
                _queue.RemoveFirst();
                dropped++;
                _logger.Warn($"Queue overflow (max {_maxQueueSize}): dropped tab {oldest.TabId} \"{Truncate(oldest.Text)}\"");
            }

            length = _queue.Count;
            _itemAvailable.Set();
        }

        QueueChanged?.Invoke();
        return (dropped, length);
    }

    public int UpdateConfig(int? maxQueueSize, double? maxDelaySeconds)
    {
        int dropped;
        lock (_lock)
        {
            if (maxQueueSize.HasValue)
            {
                _maxQueueSize = Math.Max(1, maxQueueSize.Value);
            }
            if (maxDelaySeconds.HasValue)
            {
                _maxDelaySeconds = Math.Max(0, maxDelaySeconds.Value);
            }

            dropped = PurgeExpiredLocked(DateTimeOffset.UtcNow);
            while (_queue.Count > _maxQueueSize)
            {
                var oldest = _queue.First!.Value;
                _queue.RemoveFirst();
                dropped++;
                _logger.Warn($"Queue trimmed after config update: dropped tab {oldest.TabId} \"{Truncate(oldest.Text)}\"");
            }
        }

        if (dropped > 0)
        {
            QueueChanged?.Invoke();
        }
        return dropped;
    }

    public SpeechQueueItem? TryDequeueNext()
    {
        SpeechQueueItem? item = null;
        bool changed = false;

        lock (_lock)
        {
            var expired = PurgeExpiredLocked(DateTimeOffset.UtcNow);
            if (expired > 0)
            {
                changed = true;
            }

            if (_queue.Count > 0)
            {
                item = _queue.First!.Value;
                _queue.RemoveFirst();
                changed = true;
            }
        }

        if (changed)
        {
            QueueChanged?.Invoke();
        }
        return item;
    }

    public int Clear(long? tabId = null)
    {
        int removed = 0;
        lock (_lock)
        {
            if (!tabId.HasValue)
            {
                removed = _queue.Count;
                _queue.Clear();
            }
            else
            {
                var node = _queue.First;
                while (node is not null)
                {
                    var next = node.Next;
                    if (node.Value.TabId == tabId.Value)
                    {
                        _queue.Remove(node);
                        removed++;
                    }
                    node = next;
                }
            }
        }

        if (removed > 0)
        {
            QueueChanged?.Invoke();
        }
        return removed;
    }

    public bool WaitForItem(int timeoutMs) => _itemAvailable.WaitOne(timeoutMs);

    public void Signal() => _itemAvailable.Set();

    private int PurgeExpiredLocked(DateTimeOffset now)
    {
        if (_maxDelaySeconds <= 0)
        {
            return 0;
        }

        int dropped = 0;
        while (_queue.Count > 0)
        {
            var first = _queue.First!.Value;
            var ageSeconds = (now - first.EnqueuedAtUtc).TotalSeconds;
            if (ageSeconds > _maxDelaySeconds)
            {
                _queue.RemoveFirst();
                dropped++;
                _logger.Warn($"Delay skip ({ageSeconds:F1}s > {_maxDelaySeconds:F1}s): dropped tab {first.TabId} \"{Truncate(first.Text)}\"");
            }
            else
            {
                break;
            }
        }
        return dropped;
    }

    private static string Truncate(string text)
    {
        var singleLine = text.Replace("\r", " ").Replace("\n", " ");
        return singleLine.Length <= 30 ? singleLine : singleLine[..30] + "...";
    }

    public void Dispose()
    {
        _itemAvailable.Dispose();
    }
}
