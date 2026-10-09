// SPDX-License-Identifier: BUSL-1.1
using System.Text.Json;
using Rung.Bridge.Core.Protocol;
using Rung.Online;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using Xunit;

public class OnlineTests
{
    static readonly string Pin = new('A', 64);
    static JsonElement Params(object value) => JsonSerializer.SerializeToElement(value);
    static ConnectRequest Target(string device = "PLC_1", string address = "192.168.250.1") => new(device, address, Pin);

    [Fact]
    public async Task SymbolReadsAreOrderedTypedAndPartial()
    {
        await using var session = new OnlineSession(new FakeDriver());
        await session.ConnectAsync(Target(), default);
        var rows = await session.ReadAsync(new[] { "\"DB\".\"Flag\"", "DB.Items[2]", "DB.Motor.Inner.Count", "IArea.Input", "DB.Missing", "DB.Denied", "DB.Big" }, default);
        Assert.Equal(new[] { "\"DB\".\"Flag\"", "DB.Items[2]", "DB.Motor.Inner.Count", "IArea.Input", "DB.Missing", "DB.Denied", "DB.Big" }, rows.Select(r => r.Name));
        Assert.Equal(true, rows[0].Value);
        Assert.Equal(42, rows[1].Value);
        Assert.Equal(7, rows[2].Value);
        Assert.Equal(false, rows[3].Value);
        Assert.Equal("SYMBOL_NOT_FOUND", rows[4].ErrorCode);
        Assert.Equal("ACCESS_DENIED", rows[5].ErrorCode);
        Assert.Null(rows[5].Value);
        Assert.Null(rows[5].ObservedAt);
        Assert.Equal("18446744073709551615", rows[6].Value);
        Assert.Equal("18446744073709551615", rows[6].Display);
        Assert.Equal("TRUE", rows[0].Display);
        Assert.NotNull(rows[0].ObservedAt);
    }

    [Fact]
    public async Task SessionsNeverShareAccessors()
    {
        await using var a = new OnlineSession(new FakeDriver(10));
        await using var b = new OnlineSession(new FakeDriver(20));
        await a.ConnectAsync(Target("A"), default);
        await b.ConnectAsync(Target("B", "192.168.250.2"), default);
        Assert.Equal(10, (await a.ReadAsync(new[] { "DB.Items[2]" }, default))[0].Value);
        Assert.Equal(20, (await b.ReadAsync(new[] { "DB.Items[2]" }, default))[0].Value);
        Assert.NotEqual(a.Info.SessionId, b.Info.SessionId);
    }

    [Theory]
    [InlineData("192.168.1.1", "TARGET_REFUSED")]
    [InlineData("::ffff:192.168.1.1", "TARGET_REFUSED")]
    [InlineData("192.168.001.001", "TARGET_REFUSED")]
    [InlineData("plc.local", "BAD_REQUEST")]
    [InlineData("0192.168.250.1", "BAD_REQUEST")]
    public async Task RefusesTargetsBeforeDriverCreation(string address, string code)
    {
        var calls = 0;
        await using var dispatcher = new OnlineDispatcher(_ => { calls++; return new FakeDriver(); });
        var response = await dispatcher.HandleAsync(JsonSerializer.Serialize(new { id = 1, method = "online.connect", @params = new { device = "P", address, certificateSha256 = Pin } }));
        Assert.Equal(code, JsonDocument.Parse(response).RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task HostHandshakeAndUnknownMethodsNeedNoDriver()
    {
        var calls = 0;
        await using var dispatcher = new OnlineDispatcher(_ => { calls++; return new FakeDriver(); });
        using var hello = JsonDocument.Parse(await dispatcher.HandleAsync("{\"id\":1,\"method\":\"bridge.hello\",\"params\":{}}"));
        Assert.Equal(1, hello.RootElement.GetProperty("result").GetProperty("protocol").GetInt32());
        Assert.Contains("online.read", hello.RootElement.GetProperty("result").GetProperty("capabilities").EnumerateArray().Select(x => x.GetString()));
        foreach (var method in new[] { "online.commit", "online.prepare", "plc.download", "online.stop", "online.write", "project.info" })
        {
            var response = await dispatcher.HandleAsync(JsonSerializer.Serialize(new { id = 2, method, @params = new { allowWrites = true } }));
            Assert.Equal("UNSUPPORTED_CAPABILITY", JsonDocument.Parse(response).RootElement.GetProperty("error").GetProperty("code").GetString());
        }
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task ConnectRequiresPinAndDisconnectIsIdempotent()
    {
        var driver = new FakeDriver();
        await using var dispatcher = new OnlineDispatcher(_ => driver);
        using var missing = JsonDocument.Parse(await dispatcher.HandleAsync("{\"id\":1,\"method\":\"online.connect\",\"params\":{\"device\":\"P\",\"address\":\"192.168.250.1\"}}"));
        Assert.Equal("CERTIFICATE_UNTRUSTED", missing.RootElement.GetProperty("error").GetProperty("code").GetString());
        using var connected = JsonDocument.Parse(await dispatcher.HandleAsync(JsonSerializer.Serialize(new { id = 2, method = "online.connect", @params = Target() }, RpcWire.Json)));
        var id = connected.RootElement.GetProperty("result").GetProperty("sessionId").GetString();
        foreach (var method in new[] { "online.state", "online.browse", "online.disconnect", "online.disconnect" })
        {
            using var result = JsonDocument.Parse(await dispatcher.HandleAsync(JsonSerializer.Serialize(new { id = 3, method, @params = new { sessionId = id } })));
            Assert.True(result.RootElement.TryGetProperty("result", out _));
        }
        Assert.True(driver.Disposed);
    }

    [Fact]
    public void ValuesPreserveTypesWithoutDriverXml()
    {
        var cases = new (PlcTag Tag, object Value, string Display)[] {
            (new PlcTagLInt("x", null!, 50) { Value = long.MinValue }, "-9223372036854775808", "-9223372036854775808"),
            (new PlcTagString("x", null!, 19) { Value = "hello" }, "hello", "'hello'"),
            (new PlcTagReal("x", null!, 8) { Value = 1.23456789f }, 1.2345679f, "1.23457"),
            (new PlcTagTime("x", null!, 11) { Value = -1500 }, "T#-1s500ms", "T#-1s500ms"),
            (new PlcTagDate("x", null!, 9) { Value = new DateTime(2026, 10, 7) }, "D#2026-10-07", "D#2026-10-07"),
        };
        foreach (var (tag, value, display) in cases) {
            var row = PlcValues.Read(tag);
            Assert.Equal(value, row.Value);
            Assert.Equal(display, row.Display);
        }
        var array = PlcValues.Read(new PlcTagBoolArray("a", null!, 1) { Value = new[] { true, false } });
        Assert.Equal(new object[] { true, false }, Assert.IsType<object[]>(array.Value));
        Assert.Equal("[TRUE, FALSE]", array.Display);
    }

    [Fact]
    public async Task BadDecodedQualityDoesNotPublishCachedValues()
    {
        await using var session = new OnlineSession(new FakeDriver());
        await session.ConnectAsync(Target(), default);
        var row = (await session.ReadAsync(new[] { "DB.BadType" }, default))[0];
        Assert.Null(row.Value);
        Assert.Null(row.ObservedAt);
        Assert.Equal("UNSUPPORTED_OBJECT", row.ErrorCode);
    }

    [Fact]
    public void DtlArraysKeepNanosecondPrecision()
    {
        var tag = new PlcTagDTLArray("a", null!, 67) {
            Value = new[] { new DateTime(2026, 10, 7) }, ValueNanosecond = new uint[] { 123456789 }
        };
        var row = PlcValues.Read(tag);
        Assert.Equal(new object[] { "DTL#2026-10-07-00:00:00.123456789" }, row.Value);
    }

    sealed class FakeDriver(int count = 42) : IOnlineDriver
    {
        public bool Disposed;
        readonly Dictionary<string, PlcTag> tags = new() {
            ["DB.Flag"] = new PlcTagBool("DB.Flag", null!, 1) { Value = true },
            ["DB.Items[2]"] = new PlcTagDInt("DB.Items[2]", null!, 7) { Value = count },
            ["DB.Motor.Inner.Count"] = new PlcTagDInt("DB.Motor.Inner.Count", null!, 7) { Value = 7 },
            ["IArea.Input"] = new PlcTagBool("IArea.Input", null!, 1) { Value = false },
            ["DB.Denied"] = new PlcTagBool("DB.Denied", null!, 1),
            ["DB.Big"] = new PlcTagULInt("DB.Big", null!, 49) { Value = ulong.MaxValue },
            ["DB.BadType"] = new PlcTagDInt("DB.BadType", null!, 7) { Value = 99 },
        };
        public Task ConnectAsync(CancellationToken token) => Task.CompletedTask;
        public Task<OnlineIdentity> IdentityAsync(CancellationToken token) => Task.FromResult(new OnlineIdentity("Test CPU", "2.9", "serial", "P"));
        public Task<OnlineSymbol[]> BrowseAsync(CancellationToken token) => Task.FromResult(tags.Select(x => new OnlineSymbol(x.Key, x.Value.Datatype, true, 0)).ToArray());
        public Task<IReadOnlyDictionary<string, PlcTag>> ResolveAsync(string[] names, CancellationToken token) => Task.FromResult<IReadOnlyDictionary<string, PlcTag>>(tags.Where(x => names.Contains(x.Key)).ToDictionary());
        public Task<S7CommPlusBatchResult<S7CommPlusTagReadResult>> ReadAsync(PlcTag[] selected, CancellationToken token) {
            foreach (var tag in selected) {
                tag.Quality = PlcTagQC.TAG_QUALITY_GOOD;
                if (tag.Name == "DB.BadType") tag.Quality = PlcTagQC.TAG_QUALITY_BAD;
            }
            return Task.FromResult(new S7CommPlusBatchResult<S7CommPlusTagReadResult>(selected.Select(t => new S7CommPlusTagReadResult(t, t.Name == "DB.Denied" ? 0x13UL : 0UL)).ToArray()));
        }
        public Task<OnlineCpuState> StateAsync(CancellationToken token) => Task.FromResult(new OnlineCpuState("Run"));
        public ValueTask DisposeAsync() { Disposed = true; return ValueTask.CompletedTask; }
    }
}
