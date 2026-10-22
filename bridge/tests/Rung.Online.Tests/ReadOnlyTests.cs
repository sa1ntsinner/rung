// SPDX-License-Identifier: BUSL-1.1
using System.Diagnostics;
using System.Text.Json;
using Rung.Bridge.Core.Protocol;
using Rung.Online;
using Xunit;

public sealed class LockedFactAttribute : FactAttribute
{
    public LockedFactAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
public sealed class LockedTheoryAttribute : TheoryAttribute
{
    public LockedTheoryAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
[Trait("Category", "ReadOnly")]
public class ReadOnlyTests
{
    [LockedFact]
    public void CanonicalProtectedTargetIsAllowedForReads()
    {
        OnlineDispatcher.ValidateTarget("192.168.1.1");
    }

    [LockedTheory]
    [InlineData("::ffff:192.168.1.1", "BAD_REQUEST")]
    [InlineData("192.168.001.001", "BAD_REQUEST")]
    [InlineData("3232235777", "BAD_REQUEST")]
    [InlineData("plc.local", "BAD_REQUEST")]
    public void AlternateTargetSpellingsRemainRefused(string target, string code)
    {
        Assert.Equal(code, Assert.Throws<RpcException>(() => OnlineDispatcher.ValidateTarget(target)).Code);
    }

    [LockedTheory]
    [InlineData("online.prepare")]
    [InlineData("online.commit")]
    public async Task DispatcherRefusesEvenForgedWriterPolicyBeforeDriverCreation(string method)
    {
        var policy = new WriterConfiguration("C:/fixture", new string('A', 64), "PLC", "192.168.1.1", new string('B', 64), true);
        await using var dispatcher = new OnlineDispatcher(_ => throw new Exception("No driver may be created."), policy);
        using var response = JsonDocument.Parse(await dispatcher.HandleAsync(JsonSerializer.Serialize(new { id = 1, method, @params = new { readOnly = false, allowWrites = true } })));
        Assert.Equal("PLC_READ_ONLY", response.RootElement.GetProperty("error").GetProperty("code").GetString());
        using var hello = JsonDocument.Parse(await dispatcher.HandleAsync("{\"id\":2,\"method\":\"bridge.hello\"}"));
        Assert.DoesNotContain("online.prepare", hello.RootElement.GetProperty("result").GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()));
    }

    [LockedTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OperationEngineRefusesWithoutResolvingOrSending(bool commit)
    {
        var engine = new WriteOperationEngine((_, _) => throw new Exception("No resolve may run."), (_, _) => throw new Exception("No mutation may run."));
        var error = await Assert.ThrowsAsync<RpcException>(async () => {
            if (commit) await engine.CommitAsync("forged", "forged", true);
            else await engine.PrepareAsync(new("run"));
        });
        Assert.Equal("PLC_READ_ONLY", error.Code);
    }

    [LockedTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SessionRefusesMutationIndependently(bool commit)
    {
        await using var session = new OnlineSession(new OnlineTests.FakeDriver());
        var error = await Assert.ThrowsAsync<RpcException>(async () => {
            if (commit) await session.CommitAsync("forged", "forged", true, default);
            else await session.PrepareAsync(new("run"), default);
        });
        Assert.Equal("PLC_READ_ONLY", error.Code);
    }

    [Fact]
    public async Task WriterStartupRefusesPrivatePolicyBeforeHandshake()
    {
        var start = new ProcessStartInfo("dotnet") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        start.Environment["RUNG_READ_ONLY"] = "1";
        start.ArgumentList.Add(typeof(OnlineDispatcher).Assembly.Location);
        start.ArgumentList.Add("--stdio"); start.ArgumentList.Add("--writer-policy-stdin");
        using var process = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try {
            await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new WriterConfiguration("C:/fixture", new string('A', 64), "PLC", "192.168.250.1", new string('B', 64), true), RpcWire.Json));
            process.StandardInput.Close();
            var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = await process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            Assert.Equal(2, process.ExitCode);
            Assert.Equal("", output);
            Assert.Contains("PLC_READ_ONLY", error);
        } finally { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    }
}
