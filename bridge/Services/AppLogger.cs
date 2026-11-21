namespace NicoNamaAivoiceBridge.Services;

public sealed class AppLogger
{
    private const int MaxEntries = 500;
    private readonly object _lock = new();
    private readonly LinkedList<string> _entries = new();

    public event Action<string>? EntryAdded;

    public void Log(string level, string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] [{level}] {message}";
        lock (_lock)
        {
            _entries.AddLast(line);
            while (_entries.Count > MaxEntries)
            {
                _entries.RemoveFirst();
            }
        }

        EntryAdded?.Invoke(line);
    }

    public void Info(string message) => Log("INFO", message);
    public void Warn(string message) => Log("WARN", message);
    public void Error(string message) => Log("ERROR", message);

    public IReadOnlyList<string> GetSnapshot()
    {
        lock (_lock)
        {
            return _entries.ToArray();
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _entries.Clear();
        }
    }
}
