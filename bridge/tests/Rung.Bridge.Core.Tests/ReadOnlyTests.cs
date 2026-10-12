// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;

public sealed class LockedFactAttribute : FactAttribute
{
    public LockedFactAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
public sealed class LockedTheoryAttribute : TheoryAttribute
{
    public LockedTheoryAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
[CollectionDefinition("ReadOnly", DisableParallelization = true)]
public class ReadOnlyCollection { }
[Collection("ReadOnly"), Trait("Category", "ReadOnly")]
public class ReadOnlyTests
{
    [LockedTheory]
    [InlineData("objects.import")]
    [InlineData("objects.delete")]
    [InlineData("objects.rename")]
    [InlineData("hardware.apply")]
    [InlineData("artifact.import")]
    [InlineData("library.import")]
    [InlineData("library.release")]
    [InlineData("library.update")]
    [InlineData("library.mastercopy")]
    [InlineData("plc.download")]
    [InlineData("plc.upload")]
    [InlineData("plc.compile")]
    [InlineData("session.discard")]
    public void MutationsRefuseBeforeOpeningSession(string method)
    {
        var dispatcher = new RpcDispatcher(() => throw new Exception("Session must not be created."), new BridgeInfo("V20", "test", "import", "compile"));
        using (var response = JsonDocument.Parse(dispatcher.Handle(JsonSerializer.Serialize(new { id = 1, method, @params = new { allowDownload = true, readOnly = false } }))))
            Assert.Equal("PLC_READ_ONLY", response.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [LockedTheory]
    [InlineData("plc.upload", true)]
    [InlineData("plc.compile", true)]
    [InlineData("plc.download", false)]
    [InlineData("objects.import", false)]
    public void ScratchUploadAdmitsOnlyUploadAndCompile(string method, bool admitted)
    {
        var flag = typeof(ReadOnlyPolicy).GetField("scratchUpload", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        ReadOnlyPolicy.AllowScratchUpload();
        try
        {
            var dispatcher = new RpcDispatcher(() => throw new InvalidOperationException("session reached"), new BridgeInfo("V20", "test", "import", "compile"));
            using (var response = JsonDocument.Parse(dispatcher.Handle(JsonSerializer.Serialize(new { id = 1, method, @params = new { request = new { address = "192.168.250.1" } } }))))
            {
                var code = response.RootElement.GetProperty("error").GetProperty("code").GetString();
                if (admitted) Assert.NotEqual("PLC_READ_ONLY", code); else Assert.Equal("PLC_READ_ONLY", code);
            }
        }
        finally { flag.SetValue(null, false); }
    }

    [LockedFact]
    public void LockSurvivesEnvironmentChange()
    {
        var dispatcher = new RpcDispatcher(() => throw new Exception("Session must not be created."), new BridgeInfo("V20", "test"));
        dispatcher.Handle("{\"method\":\"objects.delete\"}");
        try {
            Environment.SetEnvironmentVariable("RUNG_READ_ONLY", null);
            using (var response = JsonDocument.Parse(dispatcher.Handle("{\"method\":\"objects.delete\"}")))
                Assert.Equal("PLC_READ_ONLY", response.RootElement.GetProperty("error").GetProperty("code").GetString());
        } finally { Environment.SetEnvironmentVariable("RUNG_READ_ONLY", "1"); }
    }

    [LockedFact]
    public void ExistingKeeperWithoutLockCannotGrantOwnership()
    {
        var record = new KeeperRecord { State = KeeperRecord.Ready, KeeperPid = 10, KeeperStartTicks = 100, TiaPid = 20, TiaStartTicks = 200 };
        Assert.False(KeeperPolicy.Holds(record, 20, 100, 200));
        record = JsonSerializer.Deserialize<KeeperRecord>("{\"State\":\"ready\",\"KeeperPid\":10,\"KeeperStartTicks\":100,\"TiaPid\":20,\"TiaStartTicks\":200,\"ReadOnly\":true}");
        Assert.True(KeeperPolicy.Holds(record, 20, 100, 200));
    }

    [Fact]
    public void KeeperEnvironmentPreservesLockWithoutCredentials()
    {
        Assert.True(KeeperPolicy.KeeperGets("RUNG_READ_ONLY"));
        Assert.False(KeeperPolicy.KeeperGets("RUNG_PLC_PASSWORD"));
    }

    [LockedFact]
    public void ArchiveRemainsAvailable()
    {
        var dispatcher = new RpcDispatcher(() => new FakeTiaSession(), new BridgeInfo("V20", "test"));
        using (var response = JsonDocument.Parse(dispatcher.Handle("{\"id\":1,\"method\":\"project.archive\"}")))
            Assert.Equal(1234, response.RootElement.GetProperty("result").GetProperty("bytes").GetInt64());
    }
}
