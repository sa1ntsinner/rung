// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using Rung.Bridge.Core.Protocol;
using Xunit;

public sealed class WriteOperationTests
{
    [Fact]
    public void IndexedModificationsRequireVerifiedContainingWritePermission()
    {
        var writable = new OnlineSymbol("Data.Values", 7, true, 4, Writable: true);
        Assert.Same(writable, Symbols.ForWrite("Data.Values[1]", [writable]));
        Assert.Throws<RpcException>(() => Symbols.ForWrite("Data.Values[1]", [writable with { Writable = false }]));
        Assert.Throws<RpcException>(() => Symbols.ForWrite("Data.Values[1]", []));
    }
    [Fact]
    public async Task DispatcherUsesStartupPolicyAndKeepsReaderValuesUnmodifiedUntilCommit()
    {
        var directory = Path.Combine(Path.GetTempPath(), "rung-host-write-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "rung.toml"); File.WriteAllText(file, "fixture");
        var config = new WriterConfiguration(directory, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file))), "P", "192.168.250.1", new string('A', 64), true);
        var calls = 0;
        await using var dispatcher = new OnlineDispatcher(_ => new SubscriptionsTests.Driver(), config, (_, op, _) => { calls++; Assert.Equal(17, op.Value); return Task.FromResult(new WriteResult("acknowledged")); });
        async Task<System.Text.Json.JsonElement> Call(string method, object p) {
            var result = await dispatcher.HandleAsync(System.Text.Json.JsonSerializer.Serialize(new { id = 1, method, @params = p }));
            return System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(result);
        }
        try {
            var connected = await Call("online.connect", new { device = "P", address = "192.168.250.1", certificateSha256 = new string('A', 64) });
            var sessionId = connected.GetProperty("result").GetProperty("sessionId").GetString();
            var op = (await Call("online.prepare", new { sessionId, action = "modify", name = "DB.X", literal = "17" })).GetProperty("result");
            Assert.Equal(0, calls);
            var committed = await Call("online.commit", new { sessionId, operationId = op.GetProperty("operationId").GetString(), preview = op.GetProperty("preview").GetString(), confirmed = true });
            Assert.Equal("acknowledged", committed.GetProperty("result").GetProperty("outcome").GetString());
            Assert.Equal(1, calls);
            var second = await Call("online.commit", new { sessionId, operationId = op.GetProperty("operationId").GetString(), preview = op.GetProperty("preview").GetString(), confirmed = true });
            Assert.Equal("STALE_PREPARATION", second.GetProperty("error").GetProperty("code").GetString());
        } finally { File.Delete(file); Directory.Delete(directory); }
    }
    static WriteContext Context(bool allowed = true) => new(new("workspace", "P", "192.168.250.1", new string('A', 64), "CPU", "serial", "RungProve", 1, "config", "program", allowed), 5, null, "0");

    [Fact]
    public async Task HostRequiresOptInConfirmationFreshBindingAndSingleUseBeforeSending()
    {
        var current = Context(false); var calls = 0; long now = 0;
        var engine = new WriteOperationEngine((_, _) => Task.FromResult(current), (_, _) => { calls++; return Task.FromResult(new WriteResult("acknowledged")); }, () => now);
        await Assert.ThrowsAsync<RpcException>(() => engine.PrepareAsync(new("modify", "DB.X", "1")));
        current = Context();
        var op = await engine.PrepareAsync(new("modify", "DB.X", "1"));
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, false));
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, true));
        op = await engine.PrepareAsync(new("modify", "DB.X", "1"));
        current = current with { Binding = current.Binding with { ProgramRevision = "changed" } };
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, true));
        op = await engine.PrepareAsync(new("modify", "DB.X", "1")); now = 30_000;
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, true));
        Assert.Equal(0, calls);
        op = await engine.PrepareAsync(new("modify", "DB.X", "17"));
        Assert.Equal("acknowledged", (await engine.CommitAsync(op.OperationId, op.Preview, true)).Outcome);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task InvalidLiteralProtectedAddressAndChangedCapacityNeverReachWriter()
    {
        var current = Context(); var calls = 0;
        var engine = new WriteOperationEngine((_, _) => Task.FromResult(current), (_, _) => { calls++; return Task.FromResult(new WriteResult("acknowledged")); });
        await Assert.ThrowsAsync<RpcException>(() => engine.PrepareAsync(new("modify", "DB.X", "32768")));
        current = current with { Binding = current.Binding with { Address = "192.168.1.1" } };
        Assert.Equal(ErrorCodes.TargetRefused, (await Assert.ThrowsAsync<RpcException>(() => engine.PrepareAsync(new("run")))).Code);
        current = Context() with { Datatype = 19, MaxLength = 8 };
        var op = await engine.PrepareAsync(new("modify", "DB.Text", "'hello'"));
        current = current with { MaxLength = 3 };
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, true));
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task TimeoutAfterSendingIsUnknownAndNeverRetried()
    {
        var calls = 0;
        var engine = new WriteOperationEngine((_, _) => Task.FromResult(Context()), (_, _) => { calls++; throw new TimeoutException(); });
        var op = await engine.PrepareAsync(new("stop"));
        Assert.Equal("unknown", (await engine.CommitAsync(op.OperationId, op.Preview, true)).Outcome);
        await Assert.ThrowsAsync<RpcException>(() => engine.CommitAsync(op.OperationId, op.Preview, true));
        Assert.Equal(1, calls);
    }
}
