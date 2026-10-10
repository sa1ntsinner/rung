// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 public sealed class LibraryUpdateRequest { public string TypeGuid,VersionGuid,Device; }
 public sealed class LibraryUpdatePreview { public LibraryUpdateRequest Request;public string Revision,SourceVersionGuid;public string[] Addresses; }
 public static class LibraryUpdatePlan {
  public static void Check(LibraryUpdateRequest request){if(request==null||!Guid.TryParseExact(request.TypeGuid,"D",out var t)||t==Guid.Empty||!Guid.TryParseExact(request.VersionGuid,"D",out var v)||v==Guid.Empty||string.IsNullOrWhiteSpace(request.Device)||request.Device.Length>128||request.Device.Any(char.IsControl))throw new RpcException(ErrorCodes.BadRequest,"Update requires explicit type/version UUIDs and a PLC");}
  static string Comparable(LibraryImportState state,LibraryUpdateRequest request,string address,string oldGuid,bool after){
   var copy=new LibraryImportState{Libraries=HardwarePlan.Copy(state.Libraries),Hardware=HardwarePlan.Copy(state.Hardware),Objects=new SortedDictionary<string,string>(state.Objects,StringComparer.Ordinal)};
   void Visit(DescribeNode node,bool target){target|=node.Attributes!=null&&node.Attributes.TryGetValue("Guid",out var guid)&&guid==request.TypeGuid;if(target)node.Children?.Remove("Instances");if(node.Children!=null)foreach(var children in node.Children.Values)foreach(var child in children)Visit(child,target);}
   Visit(copy.Libraries,false);
   if(!copy.Objects.TryGetValue(address,out var value))throw new RpcException(ErrorCodes.ImportFailed,"Updated definition disappeared");
   using(var doc=JsonDocument.Parse(value)){
    if(doc.RootElement.GetProperty("libraryTypeGuid").GetString()!=request.TypeGuid||doc.RootElement.GetProperty("libraryVersionGuid").GetString()!=(after?request.VersionGuid:oldGuid))throw new RpcException(ErrorCodes.ImportFailed,"Native update binding differs");
   }
   if(after)copy.Objects[address]=value.Replace("\"libraryVersionGuid\":\""+request.VersionGuid+"\"","\"libraryVersionGuid\":\""+oldGuid+"\"").Replace("\"isConsistent\":false","\"isConsistent\":true");
   return LibraryImportPlan.Revision(copy);
  }
  // ponytail: only equal native definitions and one used FB; no alias consolidation or unused cleanup.
  public static LibraryImportResult Apply(Func<LibraryImportState> read,LibraryUpdateRequest request,string address,string oldGuid,string expectedRevision,Action update,Action<Action> transaction){
   Check(request);LibraryImportPlan.CheckRevision(expectedRevision);var before=read();var revision=LibraryImportPlan.Revision(before);if(revision!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project changed since update preview");
   var comparable=Comparable(before,request,address,oldGuid,false);string validated=null;
   void Verify(LibraryImportState actual){if(Comparable(actual,request,address,oldGuid,true)!=comparable)throw new RpcException(ErrorCodes.ImportFailed,"Update changed unreviewed objects or definitions");}
   try{transaction(()=>{update();var actual=read();Verify(actual);validated=LibraryImportPlan.Revision(actual);});var after=read();Verify(after);var current=LibraryImportPlan.Revision(after);if(current!=validated)throw new RpcException(ErrorCodes.ImportFailed,"Commit changed validated update state");return new LibraryImportResult{TypeGuid=request.TypeGuid,VersionGuid=request.VersionGuid,Address=address,State="Committed",Revision=current};}
   catch(Exception error){try{if(LibraryImportPlan.Revision(read())!=revision)throw new InvalidOperationException("Original state differs");}catch(Exception restoration){throw new RpcException(ErrorCodes.ImportFailed,"RESTORATION FAILED after library update: "+restoration.Message+"; original error: "+error.Message);}throw new RpcException(ErrorCodes.ImportFailed,"Library update refused; original state restored: "+error.Message);}
  }
 }
}
