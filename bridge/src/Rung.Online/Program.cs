// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;

if (args.Length == 0 || args is ["--stdio"] or ["--stdio", "--writer-policy-stdin"])
{
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    Console.OutputEncoding = new System.Text.UTF8Encoding(false);
    WriterConfiguration? policy = null;
    if (args.Length == 2) {
        try {
            using var startupTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var frame = new System.Text.StringBuilder();
            var character = new char[1];
            while (true) {
                if (await Console.In.ReadAsync(character.AsMemory(), startupTimeout.Token) == 0) throw new InvalidDataException();
                if (character[0] == '\n') break;
                if (frame.Length >= 16_384) throw new InvalidDataException();
                frame.Append(character[0]);
            }
            policy = System.Text.Json.JsonSerializer.Deserialize<WriterConfiguration>(frame.ToString(), Rung.Bridge.Core.Protocol.RpcWire.Json);
            if (policy == null || !policy.AllowWrites || new[] { policy.Workspace, policy.ConfigRevision, policy.Device, policy.Address, policy.CertificateSha256 }.Any(string.IsNullOrWhiteSpace)) throw new InvalidDataException();
            OnlineDispatcher.ValidateTarget(policy.Address);
            if (policy.ConfigRevision.Length != 64 || !policy.ConfigRevision.All(Uri.IsHexDigit) || policy.CertificateSha256.Length != 64 || !policy.CertificateSha256.All(Uri.IsHexDigit)) throw new InvalidDataException();
        } catch { await Console.Error.WriteLineAsync("Invalid private writer startup policy."); return 2; }
    }
    await using var dispatcher = new OnlineDispatcher(writerConfiguration: policy);
    var outputGate = new SemaphoreSlim(1, 1);
    // Keep the latest complete frame for every logical subscription when stdout is slow.
    var pending = new Dictionary<string, string>();
    var events = System.Threading.Channels.Channel.CreateBounded<bool>(new System.Threading.Channels.BoundedChannelOptions(1) {
        FullMode = System.Threading.Channels.BoundedChannelFullMode.DropWrite, SingleReader = true,
    });
    dispatcher.Event += frame => {
        using var json = System.Text.Json.JsonDocument.Parse(frame);
        var id = json.RootElement.GetProperty("params").GetProperty("subscriptionId").GetString()!;
        lock (pending) pending[id] = frame;
        events.Writer.TryWrite(true);
    };
    async Task WriteAsync(string frame) {
        await outputGate.WaitAsync();
        try { await Console.Out.WriteLineAsync(frame); await Console.Out.FlushAsync(); }
        finally { outputGate.Release(); }
    }
    var eventWriter = Task.Run(async () => {
        await foreach (var _ in events.Reader.ReadAllAsync()) {
            string[] frames;
            lock (pending) { frames = pending.Values.ToArray(); pending.Clear(); }
            foreach (var frame in frames) await WriteAsync(frame);
        }
    });
    string? line;
    while ((line = await Console.In.ReadLineAsync()) != null)
        if (line.Length > 0) await WriteAsync(await dispatcher.HandleAsync(line));
    await dispatcher.DisposeAsync();
    events.Writer.TryComplete();
    await eventWriter;
    return 0;
}

using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
Console.CancelKeyPress += (_, e) => { e.Cancel = true; timeout.Cancel(); };
return await ProbeCommand.RunAsync(args, Console.In, Console.Out, Console.Error,
    () => Environment.GetEnvironmentVariable("RUNG_ONLINE_CERTIFICATE_SHA256"),
    (options, password, pin, token) => Probe.RunAsync(options, password, pin, Console.Out, token), timeout.Token);
