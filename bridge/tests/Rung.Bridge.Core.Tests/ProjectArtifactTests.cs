// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
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
 [Fact] public void TechnologyNativeArtifactListsEveryChangedStartValueByParameterPath(){
  var bytes=File.ReadAllBytes(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Fixtures","technology-v20.xml"));var xml=Encoding.UTF8.GetString(bytes);
  byte[] Edit(params (string from,string to)[] edits){var s=xml;foreach(var e in edits){Assert.Contains(e.from,s);s=s.Replace(e.from,e.to);}return Encoding.UTF8.GetBytes(s);}
  var upper=("<Member Name=\"InputUpperLimit\" Datatype=\"Real\" />","<Member Name=\"InputUpperLimit\" Datatype=\"Real\"><StartValue>130.0</StartValue></Member>");
  var invert=("<Member Name=\"InvertControl\" Datatype=\"Bool\" />","<Member Name=\"InvertControl\" Datatype=\"Bool\"><StartValue>true</StartValue></Member>");
  var changes=TechnologyArtifact.Preview(bytes,Edit(upper,invert));
  Assert.Equal(new[]{"Config.InvertControl","Config.InputUpperLimit"},changes.Select(c=>c.Parameter).ToArray());
  Assert.All(changes,c=>Assert.Equal("RungPID_Probe",c.Name));
  Assert.Equal(new[]{"true","130.0"},changes.Select(c=>c.Value).ToArray());
  Assert.Equal(new[]{"Bool","Real"},changes.Select(c=>c.Datatype).ToArray());
  Assert.Empty(TechnologyArtifact.Preview(bytes,bytes));
  // identity, structure and removed start values (an unknown default) refuse
  Assert.Throws<RpcException>(()=>TechnologyArtifact.Preview(bytes,Edit(("<Name>RungPID_Probe</Name>","<Name>Other</Name>"))));
  Assert.Throws<RpcException>(()=>TechnologyArtifact.Preview(bytes,Edit(("<Member Name=\"InputLowerLimit\" Datatype=\"Real\" />",""))));
  Assert.Throws<RpcException>(()=>TechnologyArtifact.Preview(Edit(upper),bytes));
 }
}
