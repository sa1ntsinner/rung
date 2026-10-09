// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using Rung.Bridge.Core;
using Xunit;

/// <summary>
/// The keeper holds a TIA Portal without window open for every bridge of one project, so commands attach in
/// milliseconds instead of starting TIA Portal each time. It ends on its own when nobody needs it.
/// </summary>
public class KeeperTests
{
    static readonly DateTime T0 = new DateTime(2026, 10, 6, 9, 0, 0, DateTimeKind.Utc);
    static readonly TimeSpan Idle = TimeSpan.FromMinutes(10);

    static KeeperVerdict Decide(bool open = true, int others = 0, bool modified = false, double idleMinutes = 0) =>
        KeeperPolicy.Decide(open, others, modified, T0, T0.AddMinutes(idleMinutes), Idle);

    [Fact] public void StaysWhileABridgeIsAttached() => Assert.Equal(KeeperVerdict.Stay, Decide(others: 1, idleMinutes: 60));

    [Fact] public void StaysUntilTheIdleTimeHasPassed() => Assert.Equal(KeeperVerdict.Stay, Decide(idleMinutes: 9.9));

    [Fact] public void EndsWhenIdleAndUnchanged() => Assert.Equal(KeeperVerdict.Exit, Decide(idleMinutes: 10));

    [Fact] public void EndsAtOnceWhenSomeoneClosedTheProject() => Assert.Equal(KeeperVerdict.Exit, Decide(open: false, others: 2));

    [Fact] public void NeverSavesAndNeverDiscardsChanges()
    {
        // saving is a write each bridge is or is not allowed (sync.save of its workspace, which can change);
        // the keeper decides nothing about it: with changes it stays
        Assert.Equal(KeeperVerdict.Stay, Decide(modified: true, idleMinutes: 600));
    }

    [Fact] public void AReaderNeverBlocksTheKeeperReplacingItsRecord()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rung-keeper-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(dir, "k.json");
        try
        {
            KeeperFile.Write(file, new KeeperRecord { KeeperPid = 1, State = KeeperRecord.Starting });
            using (KeeperFile.OpenRead(file)) // a bridge polling at that moment
                KeeperFile.Write(file, new KeeperRecord { KeeperPid = 1, State = KeeperRecord.Ready });
            Assert.Equal(KeeperRecord.Ready, KeeperFile.Read(file).State);
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact] public void ATiaPortalWhoseKeeperDiedIsOursOnlyWhenEverythingMatches()
    {
        var r = new KeeperRecord { KeeperPid = 10, TiaPid = 20, TiaStartTicks = 123, Project = @"C:\P\P.ap20", State = KeeperRecord.Ready };
        Assert.True(KeeperPolicy.IsOrphan(r, keeperAlive: false, tiaStartTicks: 123, listedByOpenness: false));
        Assert.False(KeeperPolicy.IsOrphan(r, keeperAlive: true, tiaStartTicks: 123, listedByOpenness: false));
        Assert.False(KeeperPolicy.IsOrphan(r, keeperAlive: false, tiaStartTicks: 124, listedByOpenness: false)); // another process got the pid
        Assert.False(KeeperPolicy.IsOrphan(r, keeperAlive: false, tiaStartTicks: null, listedByOpenness: false)); // already gone
        Assert.False(KeeperPolicy.IsOrphan(r, keeperAlive: false, tiaStartTicks: 123, listedByOpenness: true)); // still usable: attach
        Assert.False(KeeperPolicy.IsOrphan(null, keeperAlive: false, tiaStartTicks: 123, listedByOpenness: false));
    }

    [Theory]
    [InlineData(true, false, false, false, WindowStep.Show)]           // a TIA Portal window has it: just show
    [InlineData(false, true, false, false, WindowStep.Move)]           // rung's keeper holds it: move it into a window
    [InlineData(false, true, true, true, WindowStep.SaveAndMove)]      // changes rung may save go along
    [InlineData(false, true, true, false, WindowStep.Unsaved)]         // changes nobody allowed to save: ask first
    [InlineData(false, false, false, false, WindowStep.Busy)]          // another program's TIA Portal without window: never closed
    public void OpeningInATiaPortalWindow(bool window, bool rungHolds, bool modified, bool saveAllowed, WindowStep expected) =>
        Assert.Equal(expected, WindowHandoff.Decide(window, rungHolds, modified, saveAllowed));

    sealed class EngineeringObjectDisposedException : Exception { public EngineeringObjectDisposedException(string m) : base(m) { } }
    sealed class RemotingException : Exception { public RemotingException(string m) : base(m) { } }

    [Fact] public void TiaPortalGoneIsToldApartFromADeletedObject()
    {
        Assert.True(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new EngineeringObjectDisposedException("Access to a disposed object of type 'Siemens.Engineering.Project' is not possible.")));
        // V20 after the TIA Portal window was closed under a listing (seen live)
        Assert.True(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new EngineeringObjectDisposedException("Access to a disposed object of type 'Siemens.Engineering.HW.DeviceComposition' is not possible.\n\nSystem.Runtime.Remoting.RemotingException : TIA Portal cannot be accessed because it has either been killed or is no longer running.")));
        Assert.True(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new InvalidOperationException("x", new RemotingException("gone"))));
        // the proxy of a TIA Portal that ended (seen live after closing the TIA Portal window)
        Assert.True(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new ObjectDisposedException("Siemens.Engineering.HW.DeviceComposition", "Unexpected exception.")));
        Assert.False(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new ObjectDisposedException("System.IO.FileStream")));
        // the engineer deleted the block in a running TIA Portal
        Assert.False(Rung.Bridge.Core.Protocol.RpcDispatcher.PortalGone(new EngineeringObjectDisposedException("Access to a disposed object of type 'Siemens.Engineering.SW.Blocks.FB' is not possible.")));
    }

    [Fact] public void TheKeeperGetsTheEnvironmentButNoSecret()
    {
        Assert.False(KeeperPolicy.KeeperGets("RUNG_PLC_PASSWORD"));
        Assert.False(KeeperPolicy.KeeperGets("RUNG_PLC_USER"));
        Assert.False(KeeperPolicy.KeeperGets("rung_webapi_password"));
        Assert.False(KeeperPolicy.KeeperGets("GH_TOKEN"));
        Assert.True(KeeperPolicy.KeeperGets("RUNG_OPENNESS_DIR"));
        Assert.True(KeeperPolicy.KeeperGets("RUNG_KEEPER_IDLE_S"));
        Assert.True(KeeperPolicy.KeeperGets("path"));
        Assert.True(KeeperPolicy.KeeperGets("SystemRoot"));
        Assert.False(KeeperPolicy.KeeperGets("VENDOR_API_KEY"));
        Assert.False(KeeperPolicy.KeeperGets("UNRELATED_SETTING"));
    }

    [Fact] public void OneRecordPerProjectWhateverTheSpelling()
    {
        Assert.Equal(KeeperFile.PathFor(@"C:\Work\Line\Line.ap20"), KeeperFile.PathFor(@"c:/work/line/LINE.ap20"));
        Assert.NotEqual(KeeperFile.PathFor(@"C:\Work\Line\Line.ap20"), KeeperFile.PathFor(@"C:\Work\Line2\Line2.ap20"));
    }

    [Fact] public void RecordRoundTripsAndAMissingOrBrokenFileReadsAsNone()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rung-keeper-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(dir, "k.json");
        try
        {
            Assert.Null(KeeperFile.Read(file));
            KeeperFile.Write(file, new KeeperRecord { KeeperPid = 1, KeeperStartTicks = 9, TiaPid = 2, TiaStartTicks = 3, Project = "p", State = KeeperRecord.Failed, Error = "locked" });
            var r = KeeperFile.Read(file);
            Assert.Equal(1, r.KeeperPid);
            Assert.Equal(9, r.KeeperStartTicks);
            Assert.Equal(2, r.TiaPid);
            Assert.Equal(3, r.TiaStartTicks);
            Assert.Equal("failed", r.State);
            Assert.Equal("locked", r.Error);
            File.WriteAllText(file, "{ half");
            Assert.Null(KeeperFile.Read(file));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}
