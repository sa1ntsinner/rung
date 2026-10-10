// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;
using System.Text;
public class LibraryUpdateTests {
 const string Type="b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e",Old="51acffde-45c4-45db-a591-a5840bb011af",New="818da570-1605-4483-998d-5d8201561e80";
 static DescribeNode Node()=>new DescribeNode{Type="node",Name="root",Attributes=new SortedDictionary<string,string>(StringComparer.Ordinal),Children=new SortedDictionary<string,List<DescribeNode>>(StringComparer.Ordinal)};
 static LibraryImportState State(){var root=Node();return new LibraryImportState{Libraries=root,Hardware=Node(),Objects=new SortedDictionary<string,string>(StringComparer.Ordinal){["FB"]="{\"libraryTypeGuid\":\""+Type+"\",\"libraryVersionGuid\":\""+Old+"\",\"revision\":\"body\",\"isConsistent\":true}",["DB"]="unchanged"}};}
 [Fact] public void UpdateRequiresExplicitTargetAndPreservesOutsideObjects(){
  var state=State();var request=new LibraryUpdateRequest{TypeGuid=Type,VersionGuid=New,Device="PLC_1"};LibraryUpdatePlan.Check(request);
  var rev=LibraryImportPlan.Revision(state);var touched=false;
  Assert.Throws<RpcException>(()=>LibraryUpdatePlan.Apply(()=>state,request,"FB",Old,new string('a',64),()=>{touched=true;},work=>work()));Assert.False(touched);
  var result=LibraryUpdatePlan.Apply(()=>state,request,"FB",Old,rev,()=>state.Objects["FB"]=state.Objects["FB"].Replace(Old,New).Replace("true","false"),work=>work());Assert.Equal(New,result.VersionGuid);
 }
 [Fact] public void UpdateRejectsDefinitionOrDbChangesAndChecksRollback(){
  var state=State();var request=new LibraryUpdateRequest{TypeGuid=Type,VersionGuid=New,Device="PLC_1"};var rev=LibraryImportPlan.Revision(state);
  var error=Assert.Throws<RpcException>(()=>LibraryUpdatePlan.Apply(()=>state,request,"FB",Old,rev,()=>{state.Objects["DB"]="mutated";},work=>{try{work();}catch{state=State();throw;}}));Assert.DoesNotContain("RESTORATION FAILED",error.Message);
  error=Assert.Throws<RpcException>(()=>LibraryUpdatePlan.Apply(()=>state,request,"FB",Old,rev,()=>state.Objects["FB"]=state.Objects["FB"].Replace(Old,New).Replace("body","other"),work=>work()));Assert.Contains("RESTORATION FAILED",error.Message);
 }
 [Fact] public void InstantiationHashIgnoresOnlyNativeIdentityFields(){
  string Xml(string number,string body)=>"<Document><Engineering version='V20'/><SW.Blocks.FB ID='0'><AttributeList><Name>FB</Name><Number>"+number+"</Number><AutoNumber>false</AutoNumber><Body>"+body+"</Body></AttributeList></SW.Blocks.FB></Document>";
  Assert.Equal(LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Xml("1","same")),true),LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Xml("2","same")),true));
  Assert.NotEqual(LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Xml("1","same")),true),LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Xml("2","changed")),true));
 }
 [Fact] public void UpdateRpcValidatesBeforeOpening(){
  var opened=false;var d=new RpcDispatcher(()=>{opened=true;return new FakeTiaSession();},new BridgeInfo("V20","test"));
  Assert.Contains(ErrorCodes.BadRequest,d.Handle("{\"id\":1,\"method\":\"library.update.preview\",\"params\":{\"typeGuid\":\"bad\"}}"));Assert.False(opened);
  Assert.Contains("result",d.Handle("{\"id\":2,\"method\":\"library.update.preview\",\"params\":{\"typeGuid\":\""+Type+"\",\"versionGuid\":\""+New+"\",\"device\":\"PLC_1\"}}"));Assert.True(opened);
 }
}
