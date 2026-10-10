// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class LibraryImportTests
{
    static DescribeNode Node(string name, string guid = null) => new DescribeNode { Type = "node", Name = name,
        Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) };
    static LibraryImportState State() => new LibraryImportState { Libraries = Node("library"), Hardware = Node("hardware"),
        Objects = new SortedDictionary<string, string>(StringComparer.Ordinal) { ["existing"] = "original" } };
    static LibraryPackage Package() => new LibraryPackage { TypeName = "NewFB", TypeGuid = "b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e",
        SourceVersionGuid = "51acffde-45c4-45db-a591-a5840bb011af", Revision = new string('a',64) };
    static LibraryImportResult Imported(LibraryImportState state, LibraryPackage package)
    {
        var type = Node(package.TypeName); type.Attributes["Guid"] = package.TypeGuid;
        state.Libraries.Children["Types"] = new List<DescribeNode> { type };
        state.Objects.Add("new", "native");
        return new LibraryImportResult { TypeGuid = package.TypeGuid, VersionGuid = Guid.NewGuid().ToString("D"),
            VersionNumber = "0.0.1", State = "InWork", Address = "new" };
    }
    [Fact] public void StaleRevisionRefusesBeforeMutationAndNativeImportReportsActualIdentity()
    {
        var state = State(); var package = Package(); var revision = LibraryImportPlan.Revision(state); var touched = false;
        Assert.Throws<RpcException>(() => LibraryImportPlan.Apply(() => state, package, new string('b',64), () => { touched=true;return null; }, work=>work()));
        Assert.False(touched);
        var result = LibraryImportPlan.Apply(() => state, package, revision, () => Imported(state,package), work=>work());
        Assert.Equal("InWork",result.State); Assert.NotEqual(package.SourceVersionGuid,result.VersionGuid);
        Assert.Equal(LibraryImportPlan.Revision(state),result.Revision);
    }
    [Fact] public void V21KeepsThePackagesVersionNumberOnTheNewInWorkVersion()
    {
        // seen live: TIA Portal V21 imports a 1.0.0 package as 1.0.0 InWork, V20 as 0.0.1 InWork
        var state = State(); var package = Package(); package.VersionNumber = "1.0.0";
        var result = LibraryImportPlan.Apply(() => state, package, LibraryImportPlan.Revision(state), () => { var r = Imported(state, package); r.VersionNumber = "1.0.0"; return r; }, work => work());
        Assert.Equal("1.0.0", result.VersionNumber);
        state = State();
        Assert.Throws<RpcException>(() => LibraryImportPlan.Apply(() => state, package, LibraryImportPlan.Revision(state), () => { var r = Imported(state, package); r.VersionNumber = "2.0.0"; return r; }, work => { try { work(); } catch { state = State(); throw; } }));
    }
    [Fact] public void UnexpectedSideEffectRollsBackAndFailedRestorationIsExplicit()
    {
        var state=State();var package=Package();var revision=LibraryImportPlan.Revision(state);
        var error=Assert.Throws<RpcException>(()=>LibraryImportPlan.Apply(()=>state,package,revision,()=> {
            var result=Imported(state,package);state.Objects["existing"]="changed";return result;
        },work=> { try { work(); } catch { state=State();throw; } }));
        Assert.Equal(ErrorCodes.ImportFailed,error.Code);Assert.Equal(revision,LibraryImportPlan.Revision(state));
        error=Assert.Throws<RpcException>(()=>LibraryImportPlan.Apply(()=>state,package,revision,()=> {
            var result=Imported(state,package);result.VersionGuid=package.SourceVersionGuid;return result;
        },work=>work()));
        Assert.Contains("RESTORATION FAILED",error.Message);
    }
    [Fact] public void CommitMustNotChangeTheNewObjectAfterPrecommitValidation()
    {
        var state=State();var package=Package();
        var error=Assert.Throws<RpcException>(()=>LibraryImportPlan.Apply(()=>state,package,LibraryImportPlan.Revision(state),()=>Imported(state,package),
            work=> { work();state.Objects["new"]="unexpected committed binding"; }));
        Assert.Contains("RESTORATION FAILED",error.Message);
    }
}
