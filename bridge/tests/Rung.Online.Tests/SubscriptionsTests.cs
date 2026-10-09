// SPDX-License-Identifier: BUSL-1.1
using System.Text.Json;
using Rung.Online;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using Xunit;

public class SubscriptionsTests
{
    [Fact]
    public async Task AbsoluteAndSymbolicRequestsShareTheTagAndBothReceiveNotifications()
    {
        var driver = new Driver { Absolute = "%MW2" };
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        JsonElement received = default;
        session.Values += value => received = JsonSerializer.SerializeToElement(value, RpcWire.Json);
        await session.SubscribeAsync(["%MW2", "DB.X"], 250, default);
        driver.Notify!([new("DB.X", 9, ObservedAt: 123)]);
        var items = received.GetProperty("items");
        Assert.Equal("%MW2", items[0].GetProperty("name").GetString());
        Assert.Equal(9, items[0].GetProperty("value").GetInt32());
        Assert.Equal(9, items[1].GetProperty("value").GetInt32());
    }
    [Fact]
    public async Task NewConsumerResumesAfterAllLeasesLeftDuringOutage()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var reconnecting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var restored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "reconnecting") reconnecting.TrySetResult();
            if (json.GetProperty("connectionState").GetString() == "connected") restored.TrySetResult();
        };
        using var lease = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X" }, 250, default), RpcWire.Json));
        driver.Fail!(new IOException("offline"));
        await reconnecting.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await session.UnsubscribeAsync(lease.RootElement.GetProperty("subscriptionId").GetString()!);
        await Task.Delay(1200);
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        await restored.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, driver.Connections);
    }
    [Fact]
    public async Task RecoveryKeepsNewerStartupNotification()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var restored = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "connected" && json.GetProperty("scope").GetProperty("epoch").GetInt64() == 2) restored.TrySetResult(json);
        };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.StartupValue = 2;
        driver.Fail!(new IOException("offline"));
        var frame = await restored.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, frame.GetProperty("items")[0].GetProperty("value").GetInt32());
    }
    [Fact]
    public async Task ReplacingTheSymbolUnionDuringRecoveryKeepsItsLogicalLease()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var recovering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var restored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "reconnecting") recovering.TrySetResult();
            if (json.GetProperty("connectionState").GetString() == "connected") restored.TrySetResult();
        };
        using var first = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X" }, 250, default), RpcWire.Json));
        driver.Fail!(new IOException("offline"));
        await recovering.Task.WaitAsync(TimeSpan.FromSeconds(2));
        using var replacement = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X", "DB.Y" }, 250, default), RpcWire.Json));
        Assert.Equal("reconnecting", replacement.RootElement.GetProperty("snapshot").GetProperty("connectionState").GetString());
        await session.UnsubscribeAsync(first.RootElement.GetProperty("subscriptionId").GetString()!);
        await restored.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, session.Info.Scope.Epoch);
        Assert.Equal(2, driver.Subscriptions);
    }
    [Fact]
    public async Task UnsubscribeDuringOutageDoesNotWaitForRecovery()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var recovering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "reconnecting") recovering.TrySetResult();
        };
        using var result = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X" }, 250, default), RpcWire.Json));
        driver.ConnectError = new IOException("offline");
        driver.Fail!(new IOException("offline"));
        await recovering.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(await session.UnsubscribeAsync(result.RootElement.GetProperty("subscriptionId").GetString()!).WaitAsync(TimeSpan.FromSeconds(2)));
    }
    [Fact]
    public async Task RecoverySurvivesMoreThanThreeTransientFailures()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var restored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "connected") restored.TrySetResult();
        };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.TransientFailures = 3;
        driver.Fail!(new IOException("offline"));
        await restored.Task.WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(5, driver.Connections);
    }
    [Fact]
    public async Task ChangedCpuIdentityStopsRecoveryBeforeReadingOrSubscribing()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "disconnected") stopped.TrySetResult();
        };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.Serial = "different-cpu";
        driver.Fail!(new IOException("offline"));
        await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, driver.Subscriptions);
        Assert.Equal(2, driver.Connections);
        Assert.Equal("serial", session.Info.Identity.Serial);
    }
    [Fact]
    public async Task SubscriptionFaultWhileRebuildingUsesNextBoundedAttempt()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var restored = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "connected")
                restored.TrySetResult(json.GetProperty("scope").GetProperty("epoch").GetInt64());
        };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.FailWhileSubscribing = 2;
        driver.Fail!(new IOException("broken"));
        Assert.Equal(3, await restored.Task.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.Equal(3, driver.Connections);
    }
    static string Request(string method, object p) => JsonSerializer.Serialize(new { id = 1, method, @params = p }, RpcWire.Json);
    [Theory]
    [InlineData(0, "0.0")]
    [InlineData(1, "1.0")]
    [InlineData(-2, "-2.0")]
    [InlineData(1.25, "1.25")]
    [InlineData(0.000001, "1E-06")]
    [InlineData(1234567, "1.23457E+06")]
    public void RealAndLRealDisplaysKeepDecimalForWholeValues(double value, string display)
    {
        Assert.Equal(display, PlcValues.Read(new PlcTagReal("x", null!, 8) { Value = (float)value }).Display);
        Assert.Equal(display, PlcValues.Read(new PlcTagLReal("x", null!, 48) { Value = value }).Display);
    }
    [Fact]
    public async Task SubscriptionHasSnapshotAndUnsubscribeIsIdempotent()
    {
        var driver = new Driver();
        await using var host = new OnlineDispatcher(_ => driver);
        using var connect = JsonDocument.Parse(await host.HandleAsync(Request("online.connect", new ConnectRequest("P", "192.168.250.1", new string('A', 64)))));
        var sessionId = connect.RootElement.GetProperty("result").GetProperty("sessionId").GetString();
        using var reply = JsonDocument.Parse(await host.HandleAsync(Request("online.subscribe", new { sessionId, names = new[] { "DB.X" }, cycleMs = 250 })));
        Assert.True(reply.RootElement.TryGetProperty("result", out var result), reply.RootElement.ToString());
        Assert.Equal(1, result.GetProperty("snapshot").GetProperty("items")[0].GetProperty("value").GetInt32());
        var subscriptionId = result.GetProperty("subscriptionId").GetString();
        await host.HandleAsync(Request("online.unsubscribe", new { subscriptionId }));
        await host.HandleAsync(Request("online.unsubscribe", new { subscriptionId }));
        Assert.True(driver.Lease.Disposed);
    }
    [Fact]
    public async Task MalformedNamesRemainPerItemErrorsInSubscriptionSnapshot()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X", "\"bad" }, 250, default), RpcWire.Json));
        var items = json.RootElement.GetProperty("snapshot").GetProperty("items");
        Assert.Equal(1, items[0].GetProperty("value").GetInt32());
        Assert.Equal("BAD_REQUEST", items[1].GetProperty("errorCode").GetString());
        driver.Notify!(new[] { new OnlineReadItem("DB.X", 2) });
    }
    [Fact]
    public void RealDisplaysPreserveRawPrecisionAndFiniteExtremes()
    {
        foreach (var (value, display) in new (float, string)[] { (-0.0f, "-0.0"), (float.Epsilon, "1.4013E-45"), (float.MaxValue, "3.40282E+38"), (float.MinValue, "-3.40282E+38"), (0.1f, "0.1") }) {
            var item = PlcValues.Read(new PlcTagReal("x", null!, 8) { Value = value });
            Assert.Equal(value, item.Value); Assert.Equal(display, item.Display);
        }
        foreach (var (value, display) in new (double, string)[] { (-0.0, "-0.0"), (double.Epsilon, "4.94066E-324"), (double.MaxValue, "1.79769E+308"), (double.MinValue, "-1.79769E+308"), (1.2345678901234567, "1.23457") }) {
            var item = PlcValues.Read(new PlcTagLReal("x", null!, 48) { Value = value });
            Assert.Equal(value, item.Value); Assert.Equal(display, item.Display);
        }
        Assert.Equal("[0.0, 0.1]", PlcValues.Read(new PlcTagRealArray("a", null!, 8) { Value = new[] { 0f, 0.1f } }).Display);
    }
    internal sealed class Lease : IAsyncDisposable { public bool Disposed; public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; } }
    [Fact]
    public async Task LateNotificationsCannotReviveRemovedSubscription()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var frames = new List<string>();
        session.Values += frame => frames.Add(JsonSerializer.Serialize(frame, RpcWire.Json));
        using var result = JsonDocument.Parse(JsonSerializer.Serialize(await session.SubscribeAsync(new[] { "DB.X", "\"DB\".\"X\"" }, 250, default), RpcWire.Json));
        var callback = driver.Notify!;
        callback(new[] { new OnlineReadItem("DB.X", 2, "DINT", "2", 123) });
        using var update = JsonDocument.Parse(frames.Single());
        Assert.Equal(2, update.RootElement.GetProperty("items").GetArrayLength());
        Assert.All(update.RootElement.GetProperty("items").EnumerateArray(), row => Assert.Equal(2, row.GetProperty("value").GetInt32()));
        await session.UnsubscribeAsync(result.RootElement.GetProperty("subscriptionId").GetString()!);
        callback(new[] { new OnlineReadItem("DB.X", 99) });
        Assert.Single(frames);
    }
    [Fact]
    public async Task FailureRebuildsWithNewEpochAndRejectsOldGeneration()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var connected = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var frames = new List<JsonElement>();
        session.Values += frame => { var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json); lock (frames) frames.Add(json); if (json.GetProperty("connectionState").GetString() == "connected" && json.GetProperty("scope").GetProperty("epoch").GetInt64() == 2) connected.TrySetResult(); };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        var old = driver.Notify!;
        driver.Fail!(new IOException("broken"));
        await connected.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, driver.Connections);
        Assert.Equal(1, driver.Invalidations);
        var count = frames.Count;
        old(new[] { new OnlineReadItem("DB.X", 99) });
        Assert.Equal(count, frames.Count);
        Assert.Equal("reconnecting", frames[0].GetProperty("connectionState").GetString());
    }
    [Fact]
    public async Task TrustFailureStopsReconnectWithoutRetrying()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => { var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json); if (json.GetProperty("connectionState").GetString() == "disconnected") { Assert.Equal("CERTIFICATE_UNTRUSTED", json.GetProperty("errorCode").GetString()); stopped.TrySetResult(); } };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.ConnectError = new System.Security.Authentication.AuthenticationException("changed certificate");
        driver.Fail!(new IOException("broken"));
        await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, driver.Connections);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ProgramChangeInvalidatesCatalogWhileConnectionSurvives(bool sameSchema)
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var restored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => { var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json); if (json.GetProperty("scope").GetProperty("epoch").GetInt64() == 2) restored.TrySetResult(); };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        if (sameSchema) driver.CatalogAccess = "2"; else driver.CatalogType = 8;
        await session.StateAsync(default);
        await restored.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, driver.Invalidations);
    }
    [Fact]
    public async Task QuietSubscriptionHealthDoesNotRefreshMeasurementAge()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var frames = 0;
        session.Values += _ => frames++;
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        await session.StateAsync(default);
        await session.StateAsync(default);
        Assert.Equal(1, driver.Connections);
        Assert.Equal(0, frames);
    }
    [Fact]
    public async Task DisposalCancelsTransportRecoveryPromptly()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var recovering = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => { var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json); if (json.GetProperty("connectionState").GetString() == "reconnecting") recovering.TrySetResult(); };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.ConnectError = new IOException("offline");
        driver.Fail!(new IOException("offline"));
        await recovering.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await session.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(1, driver.Connections);
    }
    [Fact]
    public async Task AuthenticationFailureNotificationNeverRetries()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        session.Values += frame => { var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json); if (json.GetProperty("connectionState").GetString() == "disconnected") stopped.TrySetResult(); };
        await session.SubscribeAsync(new[] { "DB.X" }, 250, default);
        driver.Fail!(new System.Security.Authentication.AuthenticationException("certificate changed"));
        await stopped.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Equal(1, driver.Connections);
    }
    internal sealed class Driver : IOnlineDriver
    {
        public readonly Lease Lease = new();
        public Action<OnlineReadItem[]>? Notify;
        public Action<Exception>? Fail;
        public int Connections, Invalidations, TransientFailures;
        public string Serial = "serial";
        public int Subscriptions, FailWhileSubscribing;
        public int? StartupValue;
        public Exception? ConnectError;
        public uint CatalogType = 7;
        public string CatalogAccess = "1";
        public string? Absolute;
        readonly PlcTag tag = new PlcTagDInt("DB.X", null!, 7) { Value = 1 };
        public Task ConnectAsync(CancellationToken token) { Connections++; if (TransientFailures-- > 0) throw new IOException("offline"); if (ConnectError != null) throw ConnectError; return Task.CompletedTask; }
        public Task<OnlineIdentity> IdentityAsync(CancellationToken token) => Task.FromResult(new OnlineIdentity("CPU", "2.9", Serial, "P"));
        public Task<OnlineSymbol[]> BrowseAsync(CancellationToken token) => Task.FromResult(new[] {
            JsonSerializer.Deserialize<OnlineSymbol>(JsonSerializer.Serialize(new { name = "DB.X", datatype = CatalogType, readable = true, arrayElementCount = 0, accessFingerprint = CatalogAccess, absoluteAddress = Absolute }), RpcWire.Json)!
        });
        public Task<IReadOnlyDictionary<string, PlcTag>> ResolveAsync(string[] names, CancellationToken token) => Task.FromResult<IReadOnlyDictionary<string, PlcTag>>(new Dictionary<string, PlcTag> { ["DB.X"] = tag });
        public Task<S7CommPlusBatchResult<S7CommPlusTagReadResult>> ReadAsync(PlcTag[] tags, CancellationToken token) { tag.Quality = PlcTagQC.TAG_QUALITY_GOOD; return Task.FromResult(new S7CommPlusBatchResult<S7CommPlusTagReadResult>(new[] { new S7CommPlusTagReadResult(tag, 0) })); }
        public Task<OnlineCpuState> StateAsync(CancellationToken token) => Task.FromResult(new OnlineCpuState("Run"));
        public Task InvalidateAsync(CancellationToken token) { Invalidations++; return Task.CompletedTask; }
        public Task<IAsyncDisposable> SubscribeAsync(PlcTag[] tags, int cycleMs, Action<OnlineReadItem[]> notify, Action<Exception> fail, CancellationToken token) { Notify = notify; Fail = fail; if (++Subscriptions == FailWhileSubscribing) fail(new IOException("replacement subscription failed")); if (StartupValue is int value) notify(new[] { new OnlineReadItem("DB.X", value) }); return Task.FromResult<IAsyncDisposable>(Lease); }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
