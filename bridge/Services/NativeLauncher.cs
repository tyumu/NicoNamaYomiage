using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using NicoNamaAivoiceBridge.Models;

namespace NicoNamaAivoiceBridge.Services;

public static class NativeLauncher
{
    public const string HostName = "com.niconama.aivoice_bridge";

    private static readonly string[] DefaultEditorPaths =
    [
        @"C:\Program Files\AI\AIVoice\AIVoiceEditor\AIVoiceEditor.exe",
        @"C:\Program Files (x86)\AI\AIVoice\AIVoiceEditor\AIVoiceEditor.exe"
    ];

    public static bool IsNativeMessagingInvocation(string[] args)
    {
        return args.Any(a =>
            a.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(a, "--native-launch", StringComparison.OrdinalIgnoreCase));
    }

    public static int Run(BridgeSettings settings, int? portOverride)
    {
        try
        {
            var reqNode = ReadNativeMessage();
            var launchEditor = reqNode?["launchEditor"]?.GetValue<bool>() ?? true;

            var editorRunning = IsEditorRunning();
            var editorStarted = false;
            string? editorError = null;

            if (launchEditor && !editorRunning)
            {
                var editorPath = FindEditorExecutable();
                if (editorPath is not null)
                {
                    if (TryStartDetached(editorPath, null, out var err))
                    {
                        editorStarted = true;
                        editorRunning = true;
                    }
                    else
                    {
                        editorError = err;
                    }
                }
                else
                {
                    editorError = "AIVoiceEditor.exe が見つかりませんでした。";
                }
            }

            var effectivePort = portOverride ?? settings.Port;
            var bridgeRunning = IsBridgeRunning(effectivePort);
            var bridgeStarted = false;
            string? bridgeError = null;

            if (!bridgeRunning)
            {
                var selfPath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(selfPath) && File.Exists(selfPath))
                {
                    var args = portOverride.HasValue ? $"--port {portOverride.Value}" : null;
                    if (TryStartDetached(selfPath, args, out var err))
                    {
                        bridgeStarted = true;
                        bridgeRunning = true;
                    }
                    else
                    {
                        bridgeError = err;
                    }
                }
                else
                {
                    bridgeError = "ブリッジ実行ファイルのパスを取得できませんでした。";
                }
            }

            var ok = bridgeRunning || bridgeStarted;
            var error = bridgeError ?? editorError;

            WriteNativeMessage(new
            {
                ok,
                bridgeRunning,
                bridgeStarted,
                editorRunning,
                editorStarted,
                error
            });

            return ok ? 0 : 1;
        }
        catch (Exception ex)
        {
            try
            {
                WriteNativeMessage(new { ok = false, error = ex.Message });
            }
            catch
            {
                // Ignore stdout write errors if host pipe already closed.
            }
            return 1;
        }
    }

    public static bool IsEditorRunning()
    {
        try
        {
            return Process.GetProcessesByName("AIVoiceEditor").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    public static bool IsBridgeRunning(int port)
    {
        try
        {
            if (Mutex.TryOpenExisting($@"Local\NicoNamaAivoiceBridge_{port}", out var existing))
            {
                existing.Dispose();
                return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    public static string? FindEditorExecutable()
    {
        foreach (var path in DefaultEditorPaths)
        {
            if (File.Exists(path))
            {
                return path;
            }
        }

        try
        {
            var apiLocation = typeof(AI.Talk.Editor.Api.TtsControl).Assembly.Location;
            var dir = Path.GetDirectoryName(apiLocation);
            if (!string.IsNullOrEmpty(dir))
            {
                var candidate = Path.Combine(dir, "AIVoiceEditor.exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }
        catch
        {
            // Ignore assembly location lookup failures.
        }

        return null;
    }

    private static JsonNode? ReadNativeMessage()
    {
        using var stdin = Console.OpenStandardInput();
        Span<byte> lenBytes = stackalloc byte[4];
        if (!TryReadExact(stdin, lenBytes))
        {
            return null;
        }

        var len = BinaryPrimitives.ReadInt32LittleEndian(lenBytes);
        if (len <= 0 || len > 1024 * 1024)
        {
            return null;
        }

        var payload = new byte[len];
        if (!TryReadExact(stdin, payload))
        {
            return null;
        }

        var json = Encoding.UTF8.GetString(payload);
        return JsonNode.Parse(json);
    }

    private static bool TryReadExact(Stream stream, Span<byte> buffer)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer[total..]);
            if (read <= 0)
            {
                return false;
            }
            total += read;
        }
        return true;
    }

    private static void WriteNativeMessage(object payload)
    {
        var jsonBytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        Span<byte> lenBytes = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(lenBytes, jsonBytes.Length);

        using var stdout = Console.OpenStandardOutput();
        stdout.Write(lenBytes);
        stdout.Write(jsonBytes);
        stdout.Flush();
    }

    private static bool TryStartDetached(string exePath, string? arguments, out string? error)
    {
        // Use CREATE_BREAKAWAY_FROM_JOB so Chrome's Native Messaging Job Object does not kill
        // the launched bridge/editor processes when this short-lived host exits.
        const uint CreateBreakawayFromJob = 0x01000000;
        const uint DetachedProcess = 0x00000008;

        var workingDir = Path.GetDirectoryName(exePath);
        var commandLine = string.IsNullOrWhiteSpace(arguments)
            ? $"\"{exePath}\""
            : $"\"{exePath}\" {arguments}";

        var si = new STARTUPINFOW { cb = Marshal.SizeOf<STARTUPINFOW>() };
        if (CreateProcessW(
                exePath,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CreateBreakawayFromJob | DetachedProcess,
                IntPtr.Zero,
                workingDir,
                ref si,
                out var pi))
        {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            error = null;
            return true;
        }

        // Fallback via ShellExecute / explorer.exe if the parent job forbids breakaway.
        try
        {
            if (string.IsNullOrWhiteSpace(arguments))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"\"{exePath}\"",
                    UseShellExecute = false
                });
            }
            else
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exePath,
                    Arguments = arguments,
                    WorkingDirectory = workingDir ?? string.Empty,
                    UseShellExecute = true
                });
            }
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string? lpApplicationName,
        StringBuilder? lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFOW lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);
}
