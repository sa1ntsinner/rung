// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using System.Text.Json;
using Xunit;

public sealed class NativeSessionTests
{
    [Fact]
    public async Task NativeRpcRequiresExpectedScopeAndReturnsReadOnlySamples()
    {
        var driver = new SubscriptionsTests.Driver(); var calls = 0;
        driver.Capture = _ => { calls++; return Task.FromResult(new NativeCaptureResult([], [], new("DB", 4, 4, 118, "1", "258"), "signature",
            [new(123, 7, new(new() { ["X"] = 1 }, new() { ["X"] = 2 }))])); };
        await using var dispatcher = new OnlineDispatcher(_ => driver);
        static string Request(string method, object parameters) => System.Text.Json.JsonSerializer.Serialize(new { id = 1, method, @params = parameters }, Rung.Bridge.Core.Protocol.RpcWire.Json);
        using var connected = System.Text.Json.JsonDocument.Parse(await dispatcher.HandleAsync(Request("online.connect", new ConnectRequest("P", "192.168.250.1", new('A', 64)))));
        var info = connected.RootElement.GetProperty("result").Deserialize<SessionInfo>(Rung.Bridge.Core.Protocol.RpcWire.Json)!;
        using var response = System.Text.Json.JsonDocument.Parse(await dispatcher.HandleAsync(Request("online.capture", new { sessionId = info.SessionId, block = "F", instance = "DB", scope = info.Scope })));
        Assert.Equal("subscription-sample", response.RootElement.GetProperty("result").GetProperty("coherence").GetString());
        using var rejected = System.Text.Json.JsonDocument.Parse(await dispatcher.HandleAsync(Request("online.capture", new { sessionId = info.SessionId, block = "F", instance = "DB", scope = info.Scope with { Epoch = 99 } })));
        Assert.True(rejected.RootElement.TryGetProperty("error", out _));
        Assert.Equal(1, calls);
    }
    [Fact]
    public async Task ApprovedLocalNativeDriverProducesCompleteGuardedScalarState()
    {
        var certificate = Environment.GetEnvironmentVariable("RUNG_NATIVE_CAPTURE_TEST_CERT");
        if (certificate == null) return; // Explicit opt-in to the disposable local fixture.
        Assert.Equal("D46FF2A330C94C2555ED2B456ED72C0597932B6932B363C8FADC945E8D3C1213", certificate);
        var request = new ConnectRequest("PLC_1", "192.168.250.1", certificate);
        var driver = (IOnlineDriver)Activator.CreateInstance(typeof(OnlineSession).Assembly.GetType("Rung.Online.OnlineDriver")!, request)!;
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(request, default);
        Assert.Equal("10S C-7308856Zb7", session.Info.Identity.Serial);
        var result = await session.CaptureAsync("FB_ProveOps", "ProveOps_DB", session.Info.Scope, default);
        Assert.Equal("subscription-sample", result.Coherence);
        Assert.Equal(35, result.Capture.Scalars.Length);
        Assert.Equal(4u, result.Capture.Route.FunctionBlock);
        Assert.Equal(4u, result.Capture.Route.Database);
        Assert.InRange(result.Capture.Samples.Length, 3, 8);
        Assert.All(result.Capture.Samples, sample => {
            Assert.True(sample.ObservedAt > 0);
            Assert.Equal(35, sample.State.Before.Count);
            Assert.Equal(35, sample.State.After.Count);
        });
        var output = Environment.GetEnvironmentVariable("RUNG_NATIVE_CAPTURE_TEST_OUTPUT");
        if (output != null) File.WriteAllText(output, System.Text.Json.JsonSerializer.Serialize(result, Rung.Bridge.Core.Protocol.RpcWire.Json));
    }
    [Fact]
    public async Task DropsCaptureWhenExistingSubscriptionStartsRecovery()
    {
        var driver = new SubscriptionsTests.Driver();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<NativeCaptureResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        driver.Capture = async token => { entered.SetResult(); return await completed.Task; };
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        await session.SubscribeAsync(["DB.X"], 250, default);
        var pending = session.CaptureAsync("F", "DB", session.Info.Scope, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        driver.Fail!(new IOException("offline"));
        completed.SetResult(new([], [], new("DB", 4, 4, 118, "1", "258"), "signature", []));
        await Assert.ThrowsAnyAsync<Exception>(() => pending);
    }
    [Fact]
    public async Task KeepsMeasurementTimestampAndScopeAndRefusesWrongInstance()
    {
        var driver = new SubscriptionsTests.Driver();
        var sample = new NativeCaptureObservation(123, 7, new(new() { ["X"] = 1 }, new() { ["X"] = 2 }));
        var capture = new NativeCaptureResult([], [], new("DB", 4, 4, 118, "1", "258"), "signature", [sample]);
        driver.Capture = _ => Task.FromResult(capture);
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var result = await session.CaptureAsync("F", "DB", session.Info.Scope, default);
        Assert.Equal(session.Info.Scope, result.Scope);
        Assert.Equal("subscription-sample", result.Coherence);
        Assert.Equal(123, Assert.Single(result.Capture.Samples).ObservedAt);
        await Assert.ThrowsAnyAsync<Exception>(() => session.CaptureAsync("F", "Other", session.Info.Scope, default));
    }
    [Fact]
    public async Task RefusesOldScopeAndResultsCompletedAfterReaderDisposal()
    {
        var driver = new SubscriptionsTests.Driver();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<NativeCaptureResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        driver.Capture = async token => { entered.SetResult(); return await completed.Task; };
        var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        await Assert.ThrowsAnyAsync<Exception>(() => session.CaptureAsync("F", "DB", session.Info.Scope with { Epoch = 99 }, default));
        var pending = session.CaptureAsync("F", "DB", session.Info.Scope, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var closing = session.DisposeAsync().AsTask();
        completed.SetResult(new([], [], new("DB", 4, 4, 118, "1", "258"), "signature", []));
        await Assert.ThrowsAnyAsync<Exception>(() => pending);
        await closing.WaitAsync(TimeSpan.FromSeconds(2));
    }
}
