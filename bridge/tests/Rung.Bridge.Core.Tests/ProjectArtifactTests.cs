// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;
public class ProjectArtifactTests {
 [Fact]public void AssetRpcRefusesUnknownTargetsBeforeOpening(){var opened=false;var d=new RpcDispatcher(()=>{opened=true;return new FakeTiaSession();},new BridgeInfo("V20","test"));Assert.Contains(ErrorCodes.BadRequest,d.Handle("{\"id\":1,\"method\":\"artifact.export\",\"params\":{\"kind\":\"unknown\",\"device\":\"PLC_1\"}}"));Assert.False(opened);Assert.Contains("result",d.Handle("{\"id\":2,\"method\":\"artifact.export\",\"params\":{\"kind\":\"alarms\",\"device\":\"PLC_1\"}}"));Assert.True(opened);}
 [Fact] public void GuardRejectsStaleOutsideChangesAndCommitDrift(){
  var state=new ArtifactState{ProjectRevision="project",ContentRevision="old"};var revision=ArtifactPlan.Revision(state);var changed=false;
  Assert.Throws<RpcException>(()=>ArtifactPlan.Apply(()=>state,new string('a',64),"new",()=>changed=true,work=>work()));Assert.False(changed);
  Assert.Equal(ArtifactPlan.Revision(new ArtifactState{ProjectRevision="project",ContentRevision="new"}),ArtifactPlan.Apply(()=>state,revision,"new",()=>state.ContentRevision="new",work=>work()));
  state=new ArtifactState{ProjectRevision="project",ContentRevision="old"};
  var e=Assert.Throws<RpcException>(()=>ArtifactPlan.Apply(()=>state,revision,"new",()=>state.ProjectRevision="mutated",work=>{try{work();}catch{state=new ArtifactState{ProjectRevision="project",ContentRevision="old"};throw;}}));Assert.DoesNotContain("RESTORATION FAILED",e.Message);
  e=Assert.Throws<RpcException>(()=>ArtifactPlan.Apply(()=>state,revision,"new",()=>state.ContentRevision="new",work=>{work();state.ContentRevision="late";}));Assert.Contains("RESTORATION FAILED",e.Message);
 }
 [Fact] public void TechnologyNativeArtifactAllowsOnlyObservedWritableParameter(){var bytes=File.ReadAllBytes(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Fixtures","technology-v20.xml"));var xml=Encoding.UTF8.GetString(bytes);var edited=Encoding.UTF8.GetBytes(xml.Replace("<Member Name=\"InputUpperLimit\" Datatype=\"Real\" />","<Member Name=\"InputUpperLimit\" Datatype=\"Real\"><StartValue>130.0</StartValue></Member>"));var change=TechnologyArtifact.Preview(bytes,edited);Assert.Equal("RungPID_Probe",change.Name);Assert.Equal(130f,change.Value);Assert.Throws<RpcException>(()=>TechnologyArtifact.Preview(bytes,Encoding.UTF8.GetBytes(xml.Replace("<Name>RungPID_Probe</Name>","<Name>Other</Name>"))));}
}
