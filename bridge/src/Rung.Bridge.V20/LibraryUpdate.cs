// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering.Library.Types;
using Siemens.Engineering.SW.Blocks;
namespace Rung.Bridge.V20 {
 public sealed partial class OpennessSession {
  (LibraryType type,LibraryTypeVersion source,FB block,string address,string[] dbs) UpdateTarget(LibraryUpdateRequest request){
   LibraryUpdatePlan.Check(request);var plc=Plc(request.Device);var type=ProjectTypes(_project.ProjectLibrary.TypeFolder).SingleOrDefault(t=>t.Guid.ToString("D")==request.TypeGuid);
   var target=type?.Versions.SingleOrDefault(v=>v.Guid.ToString("D")==request.VersionGuid);
   if(!(target is CodeBlockLibraryTypeVersion)||!target.IsDefault||target.State!=LibraryTypeVersionState.Committed||type.Versions.Count!=2||type.Versions.Any(v=>v.State!=LibraryTypeVersionState.Committed||v.Dependencies.Any()))throw new RpcException(ErrorCodes.UnsupportedCapability,"Update requires two released dependency-free versions and an explicit default target");
   var instances=type.Versions.SelectMany(v=>Plcs().SelectMany(p=>v.FindInstances(p))).ToArray();
   if(instances.Length!=1||!(instances[0].LibraryTypeInstance is FB fb)||fb.ProgrammingLanguage.ToString()!="LAD"||fb.IsKnowHowProtected||!string.IsNullOrEmpty(fb.Namespace)||!plc.BlockGroup.Blocks.Any(b=>b.Equals(fb)))throw new RpcException(ErrorCodes.UnsupportedCapability,"Update requires one unprotected LAD FB definition in the selected PLC root");
   var source=fb.GetService<LibraryTypeInstanceInfo>().LibraryTypeVersion;if(source.Guid==target.Guid)throw new RpcException(ErrorCodes.BadRequest,"Definition already uses the requested default version");
   var dbs=LibraryTargetBlocks(plc.BlockGroup).OfType<InstanceDB>().Where(db=>db.InstanceOfName==fb.Name).ToArray();
   if(dbs.Length!=1||!plc.BlockGroup.Blocks.Any(b=>b.Equals(dbs[0]))||!string.IsNullOrEmpty(dbs[0].Namespace)||dbs[0].IsKnowHowProtected||!dbs[0].IsConsistent)throw new RpcException(ErrorCodes.UnsupportedCapability,"Update requires exactly one consistent root instance DB; unused definitions and aliases refuse");
   if(!fb.IsConsistent)throw new RpcException(ErrorCodes.BadRequest,"Compile the library definition before update");
   string Hash(LibraryTypeVersion v)=>ContentRevision(file=>v.Export(file,Siemens.Engineering.ExportOptions.WithDefaults,Siemens.Engineering.DocumentInfoOptions.None),64,bytes=>LibraryReleasePlan.DefinitionHash(bytes,true));
   var original=ContentRevision(file=>fb.Export(file,Siemens.Engineering.ExportOptions.WithDefaults,Siemens.Engineering.DocumentInfoOptions.None),64,bytes=>LibraryReleasePlan.DefinitionHash(bytes,true));
   if(Hash(source)!=original||Hash(target)!=original)throw new RpcException(ErrorCodes.UnsupportedCapability,"Initial update preserves an identical native definition; changed logic/defaults require separate validation");
   return(type,source,fb,Addr(plc.Name,"block",new System.Collections.Generic.List<string>(),fb.Name,null),new[]{Addr(plc.Name,"block",new System.Collections.Generic.List<string>(),dbs[0].Name,null)});
  }
  public LibraryUpdatePreview PreviewLibraryUpdate(LibraryUpdateRequest request){
#if TIA_V21
   throw new RpcException(ErrorCodes.UnsupportedCapability,"Native library update is validated for V20 only");
#else
   Alive();using(var access=_portal.ExclusiveAccess("rung: library update preview")){var target=UpdateTarget(request);return new LibraryUpdatePreview{Request=request,SourceVersionGuid=target.source.Guid.ToString("D"),Addresses=new[]{target.address}.Concat(target.dbs).ToArray(),Revision=LibraryImportPlan.Revision(LibraryReadState(request.TypeGuid,true))};}
#endif
  }
  public LibraryImportResult UpdateLibrary(LibraryUpdateRequest request,string expectedRevision,string operationId){
#if TIA_V21
   throw new RpcException(ErrorCodes.UnsupportedCapability,"Native library update is validated for V20 only");
#else
   Alive();FixtureGuard.CheckImport(_args.AllowImport,_args.AllowFixtureImport,_project.Path.FullName);
   using(var access=_portal.ExclusiveAccess("rung: library update")){
    var target=UpdateTarget(request);LibraryImportPlan.CheckRevision(expectedRevision);if(LibraryImportPlan.Revision(LibraryReadState(request.TypeGuid,true))!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project changed since update preview");operationId=HardwarePlan.StartOperation(operationId,_libraryOperations,"Library");LibraryImportResult result;_inImport=true;
    var originalName=target.block.Name;
    try{result=LibraryUpdatePlan.Apply(()=>LibraryReadState(request.TypeGuid,true),request,target.address,target.source.Guid.ToString("D"),expectedRevision,()=>{
     target.type.UpdateProject(Plc(request.Device));var instances=target.type.Versions.SelectMany(v=>Plcs().SelectMany(p=>v.FindInstances(p))).ToArray();if(instances.Length!=1||!(instances[0].LibraryTypeInstance is FB actual)||actual.Name!=originalName||actual.GetService<LibraryTypeInstanceInfo>()?.LibraryTypeVersion.Guid.ToString("D")!=request.VersionGuid)throw new RpcException(ErrorCodes.ImportFailed,"Native update instance set differs");
    },work=>{using(var tx=access.Transaction(_project,"rung library update "+operationId)){work();tx.CommitOnDispose();}});}finally{_inImport=false;_index.Clear();_libraryTypes.Clear();}
    Receipts.Write(operationId,"library:"+_project.Path.FullName);if(_args.SaveAfterImport)try{_project.Save();result.Saved=true;}catch(Siemens.Engineering.EngineeringException){result.Warnings=new[]{WarningCodes.SaveFailed};}return result;
   }
#endif
  }
 }
}
