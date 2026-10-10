// SPDX-License-Identifier: BUSL-1.1
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class SessionTests
{
    [Fact] public void DiscardClosesWithoutSavingDespiteAutoSave()
    {
        var s = new FakeTiaSession { SessionModified = true, SessionSaveAfterImport = true };
        var d = new RpcDispatcher(() => throw new System.Exception("must not open TIA"), new BridgeInfo("V20", "test"));
        d.SessionAttach = () => s;
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.discard\"}"));
        Assert.True(r.RootElement.GetProperty("result").GetProperty("released").GetBoolean());
        Assert.True(s.SessionClosed);
        Assert.False(s.SessionSaved);
        var later = JsonDocument.Parse(d.Handle("{\"id\":2,\"method\":\"project.info\"}"));
        Assert.Equal("PORTAL_DISPOSED", later.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void ConflictingDiscardSaveRefusesBeforeAttaching()
    {
        var attached = false;
        var d = new RpcDispatcher(() => { attached = true; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.discard\",\"params\":{\"save\":true}}"));
        Assert.Equal("BAD_REQUEST", r.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.False(attached);
    }
    [Fact] public void ReleasedBridgeNeverReopensForQueuedRequests()
    {
        var starts = 0;
        var d = new RpcDispatcher(() => { starts++; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        d.Handle("{\"id\":1,\"method\":\"session.release\"}");
        var r = JsonDocument.Parse(d.Handle("{\"id\":2,\"method\":\"project.info\"}"));
        Assert.Equal("PORTAL_DISPOSED", r.RootElement.GetProperty("error").GetProperty("code").GetString());
        d.Handle("{\"id\":3,\"method\":\"session.release\"}");
        Assert.Equal(1, starts);
    }

    [Theory]
    [InlineData(7, 42, true)]
    [InlineData(8, 42, false)]
    [InlineData(7, 43, false)]
    [InlineData(0, 42, false)]
    [InlineData(7, 0, false)]
    public void KeeperOwnershipRequiresBothProcessIdentities(long keeperTicks, long tiaTicks, bool expected)
    {
        var r = new KeeperRecord { KeeperPid = 7, TiaPid = 42, KeeperStartTicks = 7, TiaStartTicks = 42, State = KeeperRecord.Ready };
        Assert.Equal(expected, KeeperPolicy.Holds(r, 42, keeperTicks, tiaTicks));
        Assert.False(KeeperPolicy.Holds(r, 99, keeperTicks, tiaTicks));
        Assert.False(KeeperPolicy.Holds(r, 42, null, tiaTicks));
    }

    [Fact] public async System.Threading.Tasks.Task ReleaseWaitsForRecordRemovalWithoutDeletingIt()
    {
        var file = System.IO.Path.Combine(System.IO.Path.GetTempPath(), System.Guid.NewGuid().ToString("N") + ".json");
        KeeperFile.Write(file, new KeeperRecord { TiaPid = 42 });
        try
        {
            Assert.False(KeeperFile.WaitForRelease(file, 42, System.TimeSpan.FromMilliseconds(30)));
            Assert.True(System.IO.File.Exists(file));
            // a long limit: a busy runner may stretch the 100 ms below by seconds
            var waiting = System.Threading.Tasks.Task.Run(() => KeeperFile.WaitForRelease(file, 42, System.TimeSpan.FromSeconds(60)));
            await System.Threading.Tasks.Task.Delay(100);
            Assert.False(waiting.IsCompleted);
            System.IO.File.Delete(file);
            Assert.True(await waiting);
            KeeperFile.Write(file, new KeeperRecord { TiaPid = 99 });
            Assert.True(KeeperFile.WaitForRelease(file, 42, System.TimeSpan.FromMilliseconds(30)));
            Assert.Equal(99, KeeperFile.Read(file).TiaPid);
        }
        finally { System.IO.File.Delete(file); }
    }

    [Fact] public void ReleaseAttachesWithoutUsingOpeningFactory()
    {
        var d = new RpcDispatcher(() => throw new System.Exception("must not open TIA"), new BridgeInfo("V20", "test"));
        var s = new FakeTiaSession();
        d.SessionAttach = () => s;
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.release\"}"));
        Assert.True(r.RootElement.GetProperty("result").GetProperty("released").GetBoolean());
        Assert.True(s.SessionClosed);
    }

    [Fact] public void StateProbesWithoutCreatingSession()
    {
        var started = false;
        var d = new RpcDispatcher(() => { started = true; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        d.SessionProbe = () => new SessionState { ProjectPath = "fixture.ap20", TiaPid = 42, Mode = "headless", HeldBy = "keeper", KeeperPid = 7, AttachedSessions = 1 };
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.state\"}"));
        Assert.Equal(42, r.RootElement.GetProperty("result").GetProperty("tiaPid").GetInt32());
        Assert.False(started);
    }

    [Fact] public void StateUsesExistingSession()
    {
        var s = new FakeTiaSession();
        var d = new RpcDispatcher(() => s, new BridgeInfo("V20", "test"));
        d.SessionProbe = () => throw new System.Exception("must use attached session");
        d.Handle("{\"id\":1,\"method\":\"project.info\"}");
        var r = JsonDocument.Parse(d.Handle("{\"id\":2,\"method\":\"session.state\"}"));
        Assert.Equal("keeper", r.RootElement.GetProperty("result").GetProperty("heldBy").GetString());
    }

    [Theory]
    [InlineData(false, false, "PROJECT_BUSY")]
    [InlineData(true, true, "PROJECT_BUSY")]
    [InlineData(false, true, "PROJECT_UNSAVED")]
    public void RefusesUnsafeRelease(bool window, bool keeper, string code)
    {
        var s = new FakeTiaSession { SessionWindow = window, SessionKeeper = keeper, SessionModified = true };
        var d = new RpcDispatcher(() => s, new BridgeInfo("V20", "test"));
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.release\"}"));
        Assert.Equal(code, r.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.False(s.SessionClosed);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, true, false)]
    [InlineData(true, false, true)]
    public void ReleasesCleanOrAllowedChanges(bool modified, bool save, bool saveAfterImport)
    {
        var s = new FakeTiaSession { SessionModified = modified, SessionSaveAfterImport = saveAfterImport };
        var d = new RpcDispatcher(() => s, new BridgeInfo("V20", "test"));
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"session.release\",\"params\":{\"save\":" + (save ? "true" : "false") + "}}"));
        Assert.True(r.RootElement.GetProperty("result").GetProperty("released").GetBoolean());
        Assert.True(s.SessionClosed);
        Assert.Equal(modified, s.SessionSaved);
    }
}
