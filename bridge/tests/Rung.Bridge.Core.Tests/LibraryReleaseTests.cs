// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class LibraryReleaseTests
{
    const string Type = "b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e", Version = "51acffde-45c4-45db-a591-a5840bb011af";
    static DescribeNode Node(string name) => new DescribeNode { Name=name,Type="node",Attributes=new SortedDictionary<string,string>(StringComparer.Ordinal),Children=new SortedDictionary<string,List<DescribeNode>>(StringComparer.Ordinal) };
    static LibraryImportState State() {
        var root=Node("library");var type=Node("FB");type.Attributes["Guid"]=Type;root.Children["Types"]=new List<DescribeNode>{type};
        return new LibraryImportState { Libraries=root,Hardware=Node("hardware"),Objects=new SortedDictionary<string,string>(StringComparer.Ordinal){["FB"]="{}"} };
    }
    static LibraryReleaseRequest Request() => new LibraryReleaseRequest { TypeGuid=Type,VersionGuid=Version,VersionNumber="1.0.0",Author="smile",Comment="Released" };
    [Fact] public void NativeDefinitionComparesWrappedContentWithoutLosingTextOrLogicIds() {
        const string block="<SW.Blocks.FB ID='0'><AttributeList><Name>FB</Name><Text> </Text></AttributeList><ObjectList><SW.Blocks.CompileUnit ID='1'><NetworkSource><Part UId='1'/></NetworkSource></SW.Blocks.CompileUnit></ObjectList></SW.Blocks.FB>";
        const string start="<Document><Engineering version='V20'/>";
        var original=Encoding.UTF8.GetBytes(start+block+"</Document>");
        var wrapped=Encoding.UTF8.GetBytes(start+"<SW.Blocks.CodeBlockLibraryTypeVersion><ObjectList>"+block.Replace("ID='0'","ID='3' CompositionName='ContentObject'").Replace("ID='1'","ID='4'")+"</ObjectList></SW.Blocks.CodeBlockLibraryTypeVersion></Document>");
        Assert.Equal(LibraryReleasePlan.DefinitionHash(original),LibraryReleasePlan.DefinitionHash(wrapped));
        Assert.NotEqual(LibraryReleasePlan.DefinitionHash(original),LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(wrapped).Replace("<Text> </Text>","<Text></Text>"))));
        Assert.NotEqual(LibraryReleasePlan.DefinitionHash(original),LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(wrapped).Replace("UId='1'","UId='2'"))));
        Assert.Throws<RpcException>(()=>LibraryReleasePlan.DefinitionHash(Encoding.UTF8.GetBytes("<!DOCTYPE Document [<!ENTITY x 'bad'>]>"+start+block+"</Document>")));
    }
    [Fact] public void NativeReleaseReportsNewGuidAndOnlyNormalizesThatTypesBinding() {
        var state=State();var newGuid=Guid.NewGuid().ToString("D");
        state.Objects["FB"]="{\"libraryTypeGuid\":\""+Type+"\",\"libraryVersionGuid\":\""+Version+"\",\"revision\":\"same\"}";
        var result=LibraryReleasePlan.Apply(()=>state,Request(),LibraryImportPlan.Revision(state),()=>{state.Objects["FB"]=state.Objects["FB"].Replace(Version,newGuid);return newGuid;},work=>work());
        Assert.Equal(newGuid,result.VersionGuid);
    }
    [Fact] public void ReleaseRpcRefusesMalformedAndDuplicateMetadataBeforeOpening() {
        var opened=false;var dispatcher=new RpcDispatcher(()=>{opened=true;return new FakeTiaSession();},new BridgeInfo("V20","test"));
        string Rpc(string method,object parameters)=>JsonSerializer.Serialize(new{id=1,method,@params=parameters},RpcWire.Json);
        var request=Request();request.Author=new string('a',129);
        Assert.Contains(ErrorCodes.BadRequest,dispatcher.Handle(Rpc("library.release.preview",request)));Assert.False(opened);
        var valid=Rpc("library.release.preview",Request());var duplicate=valid.Replace("\"author\":", "\"author\":\"other\",\"author\":");
        Assert.Contains(ErrorCodes.BadRequest,dispatcher.Handle(duplicate));Assert.False(opened);
        Assert.Contains("result",dispatcher.Handle(valid));Assert.True(opened);
    }
    [Fact] public void ReleaseValidatesMetadataBeforeOpeningAndPreservesUnrelatedState() {
        var request=Request();LibraryReleasePlan.Check(request);request.VersionNumber="01.0.0";Assert.Throws<RpcException>(()=>LibraryReleasePlan.Check(request));request=Request();
        var state=State();var revision=LibraryImportPlan.Revision(state);var touched=false;
        Assert.Throws<RpcException>(()=>LibraryReleasePlan.Apply(()=>state,request,new string('a',64),()=>{touched=true;return Version;},work=>work()));Assert.False(touched);
        var result=LibraryReleasePlan.Apply(()=>state,request,revision,()=>{state.Libraries.Children["Types"][0].Attributes["State"]="Committed";return Version;},work=>work());
        Assert.Equal(LibraryImportPlan.Revision(state),result.Revision);
    }
    [Fact] public void ReleaseRejectsObjectChangesAndVerifiesRollbackAndCommit() {
        var state=State();var revision=LibraryImportPlan.Revision(state);
        var error=Assert.Throws<RpcException>(()=>LibraryReleasePlan.Apply(()=>state,Request(),revision,()=>{state.Objects["FB"]="changed";return Version;},work=>{try{work();}catch{state=State();throw;}}));
        Assert.DoesNotContain("RESTORATION FAILED",error.Message);Assert.Equal(revision,LibraryImportPlan.Revision(state));
        error=Assert.Throws<RpcException>(()=>LibraryReleasePlan.Apply(()=>state,Request(),revision,()=>{state.Libraries.Children["Types"][0].Attributes["State"]="Committed";return Version;},work=>{work();state.Objects["FB"]="changed after commit";}));
        Assert.Contains("RESTORATION FAILED",error.Message);
    }
}
