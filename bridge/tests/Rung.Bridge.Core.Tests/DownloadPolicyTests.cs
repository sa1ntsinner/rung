// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using Rung.Bridge.Core;
using Xunit;

// docs/downloads.md: every download question is answered "don't" unless allowed.
public class DownloadPolicyTests
{
    static readonly string[] None = new string[0];

    [Fact] public void StoppingTheCpuNeedsExplicitPermission()
    {
        var d = DownloadPolicy.Decide("StopModules", new[] { "NoAction", "StopAll" }, None, startAfter: true);
        Assert.Equal("NoAction", d.Choice);
        Assert.False(d.Allowed);
        Assert.True(d.Blocks);
        Assert.Equal("stop-cpu", d.Name);

        var ok = DownloadPolicy.Decide("StopModules", new[] { "NoAction", "StopAll" }, new[] { "stop-cpu" }, startAfter: true);
        Assert.Equal("StopAll", ok.Choice);
        Assert.True(ok.Allowed);
        Assert.False(ok.Blocks);
    }

    [Theory]
    [InlineData("DataBlockReinitialization", "reinit-db", "StopPlcAndReinitialize")]
    [InlineData("InitializeMemory", "init-memory", "AcceptAll")]
    [InlineData("ResetModule", "reset-module", "DeleteAll")]
    [InlineData("OverwriteSystemData", "overwrite-system-data", "Overwrite")]
    [InlineData("ActiveTestCanBeAborted", "abort-active-test", "AcceptAll")]
    [InlineData("ProtectionLevelChanged", "protection-level-changed", "ContinueDownloading")]
    public void RiskyQuestionsDefaultToTheSafeAnswer(string kind, string name, string risky)
    {
        var d = DownloadPolicy.Decide(kind, new[] { "NoAction", "NoChange", risky }.Distinct().ToArray(), None, true);
        Assert.Equal(name, d.Name);
        Assert.NotEqual(risky, d.Choice);
        Assert.True(d.Blocks);
        Assert.Equal(risky, DownloadPolicy.Decide(kind, new[] { "NoAction", "NoChange", risky }, new[] { name }, true).Choice);
    }

    [Theory]
    [InlineData("ConsistentBlocksDownload", "ConsistentDownload")]
    [InlineData("AllBlocksDownload", "DownloadAllBlocks")]
    [InlineData("LoadIdentificationData", "LoadNothing")]
    [InlineData("TargetForSoftware", "CPU")]
    [InlineData("UserManagementDownload", "KeepOnlineUserManagementData")]
    public void HarmlessQuestionsProceed(string kind, string choice)
    {
        var d = DownloadPolicy.Decide(kind, new[] { choice, "Other" }, None, true);
        Assert.Equal(choice, d.Choice);
        Assert.False(d.Blocks);
    }

    [Fact] public void UnknownQuestionsCancelTheDownload()
    {
        var d = DownloadPolicy.Decide("SomethingNewInV22", new[] { "NoAction", "DoIt" }, None, true);
        Assert.True(d.Blocks);
        Assert.Equal("something-new-in-v22", d.Name);
        Assert.Equal("NoAction", d.Choice);
        // allowing an unknown question by its name picks the first non-NoAction choice
        Assert.Equal("DoIt", DownloadPolicy.Decide("SomethingNewInV22", new[] { "NoAction", "DoIt" }, new[] { "something-new-in-v22" }, true).Choice);
    }

    [Fact] public void ChecksAreUncheckedUnlessAllowed()
    {
        var d = DownloadPolicy.DecideCheck("DowngradeTargetDevice", None);
        Assert.False(d.Checked);
        Assert.True(d.Blocks);
        Assert.Equal("downgrade-target-device", d.Name);
        Assert.True(DownloadPolicy.DecideCheck("DowngradeTargetDevice", new[] { "downgrade-target-device" }).Checked);
    }

    [Fact] public void TheCpuIsStartedAgainAfterwardsUnlessDisabled()
    {
        Assert.Equal("StartModule", DownloadPolicy.Decide("StartModules", new[] { "NoAction", "StartModule" }, None, startAfter: true).Choice);
        Assert.Equal("NoAction", DownloadPolicy.Decide("StartModules", new[] { "NoAction", "StartModule" }, None, startAfter: false).Choice);
        Assert.False(DownloadPolicy.Decide("StartModules", new[] { "NoAction", "StartModule" }, None, startAfter: false).Blocks);
    }

    [Fact] public void AllowNamesAreCaseAndSeparatorInsensitive() =>
        Assert.True(DownloadPolicy.Decide("StopModules", new[] { "NoAction", "StopAll" }, new[] { "Stop_CPU" }, true).Allowed);

    [Theory]
    [InlineData("StopModules", "stop-modules")]
    [InlineData("PlcMasterSecretPassword", "plc-master-secret-password")]
    [InlineData("ABCThing", "abc-thing")]
    public void KebabNames(string kind, string name) => Assert.Equal(name, DownloadPolicy.Kebab(kind));
}
