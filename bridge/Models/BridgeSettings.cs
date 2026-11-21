using System.Text.Json;

namespace NicoNamaAivoiceBridge.Models;

public sealed class BridgeSettings
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public int Port { get; set; } = 50123;
    public int MaxQueueSize { get; set; } = 5;
    public double MaxDelaySeconds { get; set; } = 10.0;
    public string? PreferredHostName { get; set; }

    public static string DefaultSettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "NicoNamaAivoiceBridge",
        "settings.json");

    public static BridgeSettings Load(string? path = null)
    {
        var targetPath = path ?? DefaultSettingsPath;
        var localFallback = Path.Combine(AppContext.BaseDirectory, "settings.json");

        var pathToRead = File.Exists(targetPath)
            ? targetPath
            : File.Exists(localFallback) ? localFallback : null;

        if (pathToRead is not null)
        {
            try
            {
                var json = File.ReadAllText(pathToRead);
                var loaded = JsonSerializer.Deserialize<BridgeSettings>(json, JsonOptions);
                if (loaded is not null)
                {
                    loaded.Normalize();
                    if (!File.Exists(targetPath))
                    {
                        loaded.Save(targetPath);
                    }
                    return loaded;
                }
            }
            catch
            {
                // Fall back to default settings if file is malformed.
            }
        }

        var defaults = new BridgeSettings();
        defaults.Save(targetPath);
        return defaults;
    }

    public void Normalize()
    {
        if (Port is < 1024 or > 65535)
        {
            Port = 50123;
        }
        if (MaxQueueSize < 1)
        {
            MaxQueueSize = 1;
        }
        if (MaxDelaySeconds < 0)
        {
            MaxDelaySeconds = 0;
        }
    }

    public void Save(string? path = null)
    {
        var targetPath = path ?? DefaultSettingsPath;
        var dir = Path.GetDirectoryName(targetPath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var json = JsonSerializer.Serialize(this, JsonOptions);
        File.WriteAllText(targetPath, json);
    }
}
