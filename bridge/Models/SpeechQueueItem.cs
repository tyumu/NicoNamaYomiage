namespace NicoNamaAivoiceBridge.Models;

public sealed record SpeechQueueItem(
    long TabId,
    string Text,
    string? VoicePreset,
    double? Volume,
    double? Speed,
    long? ClientTimestamp,
    bool IsOperator,
    DateTimeOffset EnqueuedAtUtc);

public sealed class SpeakRequest
{
    public long TabId { get; set; }
    public string? Text { get; set; }
    public string? VoicePreset { get; set; }
    public double? Volume { get; set; }
    public double? Speed { get; set; }
    public long? Timestamp { get; set; }
    public bool IsOperator { get; set; }
}

public sealed class ConfigRequest
{
    public int? MaxQueueSize { get; set; }
    public double? MaxDelaySeconds { get; set; }
}

public sealed class ClearRequest
{
    public long? TabId { get; set; }
    public bool StopCurrent { get; set; }
}
