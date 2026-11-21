using NicoNamaAivoiceBridge.Models;
using NicoNamaAivoiceBridge.Services;
using NicoNamaAivoiceBridge.UI;

namespace NicoNamaAivoiceBridge;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        var portOverride = ParsePortOverride(args);
        var settings = BridgeSettings.Load();
        var effectivePort = portOverride ?? settings.Port;

        using var mutex = new Mutex(true, $@"Local\NicoNamaAivoiceBridge_{effectivePort}", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                $"NicoNamaAivoiceBridge は既にポート {effectivePort} で起動しています。",
                "ニコ生 A.I.VOICE ブリッジ",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        var logger = new AppLogger();
        using var loggerQueue = new SpeechQueueManager(settings.MaxQueueSize, settings.MaxDelaySeconds, logger);
        using var aiVoice = new AiVoiceService(loggerQueue, logger, settings.PreferredHostName);
        using var httpServer = new BridgeHttpServer(settings, aiVoice, loggerQueue, logger, portOverride);

        try
        {
            httpServer.Start();
        }
        catch (Exception ex)
        {
            logger.Error($"Failed to start HTTP server on port {effectivePort}: {ex.Message}");
            MessageBox.Show(
                $"HTTP サーバー (ポート {effectivePort}) の起動に失敗しました:\n{ex.Message}",
                "ニコ生 A.I.VOICE ブリッジ",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using var context = new TrayApplicationContext(aiVoice, httpServer, loggerQueue, logger);
        Application.Run(context);
    }

    private static int? ParsePortOverride(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--port", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(args[i + 1], out var port)
                && port is >= 1024 and <= 65535)
            {
                return port;
            }
        }
        return null;
    }
}
