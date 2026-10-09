// SPDX-License-Identifier: BUSL-1.1
using System.Diagnostics;
using System.Text.Json;
using Rung.Online;
using Xunit;

public class StdioTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WriterStartupRequiresPrivatePolicyBeforeHandshake(bool valid)
    {
        var start = new ProcessStartInfo("dotnet") { RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add(typeof(OnlineDispatcher).Assembly.Location);
        start.ArgumentList.Add("--stdio"); start.ArgumentList.Add("--writer-policy-stdin");
        using var process = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try {
            await process.StandardInput.WriteLineAsync(valid
                ? JsonSerializer.Serialize(new WriterConfiguration("C:/fixture", new string('A', 64), "PLC", "192.168.250.1", new string('B', 64), true), Rung.Bridge.Core.Protocol.RpcWire.Json)
                : "{\"method\":\"bridge.hello\"}");
            await process.StandardInput.WriteLineAsync("{\"id\":1,\"method\":\"bridge.hello\",\"params\":{}}");
            process.StandardInput.Close();
            var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            if (valid) {
                Assert.Equal(0, process.ExitCode);
                using var hello = JsonDocument.Parse(output);
                Assert.Contains("online.prepare", hello.RootElement.GetProperty("result").GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()));
            } else { Assert.Equal(2, process.ExitCode); Assert.Equal("", output); }
        } finally { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    }

    [Fact]
    public async Task StandaloneHostHandshakesAndRefusesMutationsWithoutEngineeringDependencies()
    {
        var start = new ProcessStartInfo("dotnet") {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
        };
        start.ArgumentList.Add(typeof(OnlineDispatcher).Assembly.Location);
        start.ArgumentList.Add("--stdio");
        using var process = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try {
            await process.StandardInput.WriteLineAsync("{\"id\":1,\"method\":\"bridge.hello\",\"params\":{}}");
            using var hello = JsonDocument.Parse((await process.StandardOutput.ReadLineAsync(timeout.Token))!);
            Assert.Equal(1, hello.RootElement.GetProperty("result").GetProperty("protocol").GetInt32());
            await process.StandardInput.WriteLineAsync("{\"id\":2,\"method\":\"online.commit\",\"params\":{}}");
            using var refused = JsonDocument.Parse((await process.StandardOutput.ReadLineAsync(timeout.Token))!);
            Assert.Equal("UNSUPPORTED_CAPABILITY", refused.RootElement.GetProperty("error").GetProperty("code").GetString());
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            Assert.Equal(0, process.ExitCode);
            Assert.Equal("", await process.StandardError.ReadToEndAsync(timeout.Token));
        } finally { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    }
}
