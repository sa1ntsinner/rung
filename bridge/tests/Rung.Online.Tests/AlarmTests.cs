// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using S7CommPlusDriver.Alarming;
using Xunit;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using System.Text.Json;
using Rung.Bridge.Core.Protocol;

public sealed class AlarmTests
{
    [Fact]
    public void GoingWithTheSameOccurrenceCounterUsesCpuTimeAndRejectsOlderSnapshots()
    {
        var coming = new OnlineAlarm("1", 1, 1, 256, 2, 135, 3, true,
            "2026-10-08T10:25:18.5306280Z", 1, 1033, 1033, "Fixture");
        var going = coming with { Active = false, RawStates = 134, CpuTimestamp = "2026-10-08T10:25:22.0347266Z", ReceivedAt = 2 };
        var rows = new AlarmSet();
        rows.Merge([coming]); rows.Merge([going]);
        Assert.False(Assert.Single(rows.Snapshot).Active);
        rows.Merge([coming with { ReceivedAt = 3 }]);
        Assert.Equal(going, Assert.Single(rows.Snapshot));
        rows.Merge([going with { Active = true, ReceivedAt = 4 }]);
        Assert.Equal(going, Assert.Single(rows.Snapshot));
    }

    [Fact]
    public async Task StartupChangesSurviveAndReconnectRefreshesSnapshotAndDisposesLeases()
    {
        var driver = new Driver();
        await using var session = new OnlineSession(driver);
        await session.ConnectAsync(new("P", "192.168.250.1"), default);
        var restored = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.AlarmsChanged += frame => {
            var json = JsonSerializer.SerializeToElement(frame, RpcWire.Json);
            if (json.GetProperty("connectionState").GetString() == "connected" && json.GetProperty("scope").GetProperty("epoch").GetInt64() == 2) restored.TrySetResult(json);
        };
        var subscribed = JsonSerializer.SerializeToElement(await session.AlarmsAsync(1033, true, default), RpcWire.Json);
        Assert.Equal(2u, subscribed.GetProperty("snapshot").GetProperty("alarms")[0].GetProperty("sequence").GetUInt32());
        driver.Fail!(new IOException("offline"));
        var refreshed = await restored.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2u, refreshed.GetProperty("alarms")[0].GetProperty("sequence").GetUInt32());
        await session.UnsubscribeAsync(subscribed.GetProperty("subscriptionId").GetString()!);
        Assert.Equal(2, driver.Disposals);
    }

    sealed class Driver : IOnlineDriver
    {
        readonly SubscriptionsTests.Driver inner = new();
        public Action<Exception>? Fail;
        public int Disposals;
        public Task ConnectAsync(CancellationToken token) => inner.ConnectAsync(token);
        public Task<OnlineIdentity> IdentityAsync(CancellationToken token) => inner.IdentityAsync(token);
        public Task<OnlineSymbol[]> BrowseAsync(CancellationToken token) => inner.BrowseAsync(token);
        public Task<IReadOnlyDictionary<string, PlcTag>> ResolveAsync(string[] names, CancellationToken token) => inner.ResolveAsync(names, token);
        public Task<S7CommPlusBatchResult<S7CommPlusTagReadResult>> ReadAsync(PlcTag[] tags, CancellationToken token) => inner.ReadAsync(tags, token);
        public Task<OnlineCpuState> StateAsync(CancellationToken token) => inner.StateAsync(token);
        public ValueTask DisposeAsync() => inner.DisposeAsync();
        public Task<IAsyncDisposable> SubscribeAlarmsAsync(int lcid, Action<OnlineAlarm[], bool> notify, Action<Exception> fail, CancellationToken token) {
            Fail = fail;
            var alarm = new OnlineAlarm("1", 1, 1, 256, 2, 1, 1, true, "cpu-time", 123, lcid, lcid, "First");
            notify([alarm], true); notify([alarm with { Sequence = 2, Text = "During startup" }], false);
            return Task.FromResult<IAsyncDisposable>(new Lease(() => Disposals++));
        }
        sealed class Lease(Action close) : IAsyncDisposable { public ValueTask DisposeAsync() { close(); return ValueTask.CompletedTask; } }
    }

    [Fact]
    public void SnapshotAndNotificationsReconcileByRawIdAndSequenceWithoutLosingFallbackText()
    {
        var raw = new S7CommPlusAlarm { CpuAlarmId = ulong.MaxValue, SequenceCounter = 4, AlarmDomain = 256, MessageType = 2,
            AlarmTexts = new() { LanguageId = 1031, AlarmText = "Fallback <text>" },
            StateChange = new() { SubtypeId = (uint)S7CommPlusAlarmStateChange.SubtypeIds.Coming, Timestamp = new DateTime(2026, 10, 7, 12, 0, 0) } };
        var item = Alarms.Normalize(raw, 1033, 123);
        Assert.Equal("18446744073709551615", item.Id);
        Assert.Equal("Fallback <text>", item.Text);
        Assert.Equal(1031, item.TextLcid);
        Assert.Equal(123, item.ReceivedAt);
        Assert.StartsWith("2026-10-07T12:00:00", item.CpuTimestamp);
        var active = new AlarmSet();
        active.Merge([item with { Sequence = 5, Active = false }]);
        active.Merge([item]); // older snapshot must not resurrect the outgoing event
        Assert.False(Assert.Single(active.Snapshot).Active);
        active.Merge([item with { Sequence = 6 }]);
        active.Merge([item with { Sequence = 6, Text = "duplicate" }]);
        Assert.Equal("Fallback <text>", Assert.Single(active.Snapshot).Text);
        Assert.True(Assert.Single(active.Snapshot).Active);
    }
}
