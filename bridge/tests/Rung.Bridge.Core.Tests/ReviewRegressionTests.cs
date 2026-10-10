// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class ReviewRegressionTests
{
    [Fact] public void NativeCompileRefusalPreservesReasonAndPointsToTiaPermissions()
    {
        const string reason = "Permission to modify the safety program is missing either on F-CPU or on project level.";
        var error = CompileFailure.Refused(reason);
        Assert.Equal("TARGET_REFUSED", error.Code);
        Assert.Contains(reason, error.Message);
        Assert.Contains("TIA Portal", error.Message);
        Assert.Contains("permissions", error.Message);
    }
    [Theory]
    [InlineData(false, true, 2, WindowStep.Move)]
    [InlineData(true, true, 2, WindowStep.Busy)]
    [InlineData(false, false, 2, WindowStep.Busy)]
    [InlineData(false, true, 3, WindowStep.InUse)]
    public void DiscardNeverSavesOrOverridesOwnership(bool window, bool keeper, int attached, WindowStep expected) =>
        Assert.Equal(expected, SessionRelease.Decide(window, keeper, true, true, attached, discard: true));
    sealed class Scope : IDisposable
    {
        readonly Action _end;
        public Scope(Action end) { _end = end; }
        public void Dispose() => _end();
    }

    [Fact] public void DownloadUsesTheSelectedAddressInsteadOfTheProjectAddress()
    {
        var target = new ConnectionTarget { Address = "10.0.0.7" };
        Assert.Equal("10.0.0.7", target.DownloadAt(true, () => "192.168.0.1", address => address));
        Assert.Equal("BAD_REQUEST", Assert.Throws<RpcException>(() => target.DownloadAt(false, () => "wrong", address => address)).Code);
        target.Address = null;
        Assert.Equal("project", target.DownloadAt(false, () => "project", address => "wrong"));
        target.Address = "999.0.0.1";
        Assert.Equal("BAD_REQUEST", Assert.Throws<RpcException>(() => target.DownloadAt(true, () => "wrong", address => address)).Code);
    }

    [Fact] public void ColdOpenRechecksForAnotherOpenerAfterTakingTheLock()
    {
        var locked = false;
        string existing = null;
        var result = PortalStartup.Open(
            () => { locked = true; existing = "keeper"; return new Scope(() => locked = false); },
            () => { Assert.True(locked); return existing; },
            () => throw new Exception("must attach to the keeper that won the race"));
        Assert.Equal("keeper", result);
        Assert.False(locked);
        result = PortalStartup.Open(() => new Scope(() => { }), () => (string)null, () => "window");
        Assert.Equal("window", result);
    }

    [Fact] public void MutexNamesShareWindowsSessionsButSeparateUsersProjectsAndPurposes()
    {
        var a = KeeperFile.MutexName("keeper", "S-1-5-21-7", @"C:\P\P.ap20");
        Assert.Equal(@"Global\rung-keeper-S-1-5-21-7-" + KeeperFile.Key(@"C:\P\P.ap20"), a);
        Assert.Equal(a, KeeperFile.MutexName("keeper", "S-1-5-21-7", "c:/p/p.ap20"));
        Assert.NotEqual(a, KeeperFile.MutexName("keeper", "S-1-5-21-8", @"C:\P\P.ap20"));
        Assert.NotEqual(a, KeeperFile.MutexName("keeper-start", "S-1-5-21-7", @"C:\P\P.ap20"));
        Assert.NotEqual(a, KeeperFile.MutexName("keeper", "S-1-5-21-7", @"C:\Q\Q.ap20"));
        Assert.StartsWith(@"Local\rung-keeper-S-1-5-21-7-", KeeperFile.MutexName("keeper", "S-1-5-21-7", @"C:\P\P.ap20", false));
    }

    [Theory]
    [InlineData(2, WindowStep.Move)]
    [InlineData(3, WindowStep.InUse)]
    [InlineData(4, WindowStep.InUse)]
    public void ReleaseRefusesPeerAttachments(int attached, WindowStep expected) =>
        Assert.Equal(expected, SessionRelease.Decide(false, true, false, true, attached));

    [Fact] public void HandoffChecksDirtyStateInsideExclusiveAccess()
    {
        var modified = false;
        var closed = false;
        var exclusive = false;
        var e = Assert.Throws<RpcException>(() => WindowHandoff.Close(false, true, false,
            () => { modified = true; exclusive = true; return new Scope(() => exclusive = false); },
            () => { Assert.True(exclusive); return modified; },
            () => throw new Exception("must not save"), () => closed = true));
        Assert.Equal("PROJECT_UNSAVED", e.Code);
        Assert.False(closed);
        Assert.False(exclusive);
        WindowHandoff.Close(false, true, true,
            () => { exclusive = true; return new Scope(() => exclusive = false); },
            () => modified,
            () => { Assert.True(exclusive); modified = false; },
            () => { Assert.True(exclusive); Assert.False(modified); closed = true; });
        Assert.True(closed);
        Assert.False(exclusive);
    }

    [Fact] public void FailedStartKeepsTheIdentityForOrphanRecovery()
    {
        var r = new KeeperRecord { KeeperPid = 7, KeeperStartTicks = 8, TiaPid = 42, TiaStartTicks = 123, State = KeeperRecord.Starting };
        r.Fail("locked");
        Assert.Equal(KeeperRecord.Failed, r.State);
        Assert.Equal("locked", r.Error);
        Assert.Equal(42, r.TiaPid);
        Assert.Equal(123, r.TiaStartTicks);
        Assert.True(KeeperPolicy.IsOrphan(r, false, 123, false));
        var events = new List<string>();
        KeeperPolicy.ForgetFailed(false, () => events.Add("sweep"), () => events.Add("forget"));
        Assert.Equal(new[] { "sweep", "forget" }, events);
        events.Clear();
        Assert.Throws<RpcException>(() => KeeperPolicy.ForgetFailed(true, () => events.Add("sweep"), () => events.Add("forget")));
        Assert.Empty(events);
    }
}
