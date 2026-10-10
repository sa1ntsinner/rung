// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Alarm;
using Siemens.Engineering.SW.TechnologicalObjects;
namespace Rung.Bridge.V20 {
 public sealed partial class OpennessSession {
  PlcSoftware ArtifactPlc(string kind,string device,string name){
#if TIA_V21
   throw new RpcException(ErrorCodes.UnsupportedCapability,"Native project artifacts are validated for V20 only");
#else
   Alive();if((kind!="alarms"&&kind!="technology")||string.IsNullOrWhiteSpace(device)||device.Length>128||(kind=="alarms"?name!=null:string.IsNullOrWhiteSpace(name)||name.Length>128))throw new RpcException(ErrorCodes.BadRequest,"Invalid artifact target");
   if(Plcs().Count()!=1)throw new RpcException(ErrorCodes.UnsupportedCapability,"Initial artifact writes require one PLC; cross-PLC effects remain unproved");return Plc(device);
#endif
  }
  static byte[] NativeArtifactBytes(Action<FileInfo> export,string extension){var dir=Path.Combine(Path.GetTempPath(),"rung-artifact-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);try{var file=new FileInfo(Path.Combine(dir,"native"+extension));export(file);file.Refresh();if(!file.Exists||file.Length<1||file.Length>4*1048576)throw new RpcException(ErrorCodes.BadRequest,"Native artifact missing/oversized");return File.ReadAllBytes(file.FullName);}finally{Directory.Delete(dir,true);}}
  string[] ArtifactLanguages()=>_project.LanguageSettings.ActiveLanguages.Select(l=>l.Culture.Name).OrderBy(s=>s,StringComparer.Ordinal).ToArray();
  byte[] AlarmBytes(PlcSoftware plc,bool none=false){var provider=plc.GetService<PlcAlarmTextListProvider>();if(provider==null)throw new RpcException(ErrorCodes.UnsupportedCapability,"PLC alarm text list provider unavailable");try{return NativeArtifactBytes(file=>{var result=provider.ExportToXlsx(file);if(result.State.ToString()!="OK")throw new RpcException(ErrorCodes.ImportFailed,"Native alarm export did not return OK");},".xlsx");}catch(Siemens.Engineering.SW.Alarm.Exceptions.TextListNotFoundException){if(none)return null;throw new RpcException(ErrorCodes.UnsupportedCapability,"PLC has no alarm text lists; no empty editable workbook is fabricated");}}
  TechnologicalInstanceDB Technology(PlcSoftware plc,string name){var to=plc.TechnologicalObjectGroup.TechnologicalObjects.Find(name);if(to==null)throw new RpcException(ErrorCodes.UnsupportedCapability,"No root technology object named "+name);return to;}
  // a start value from the XML, typed like the parameter's current value; only writable elementary parameters change
  static object TechnologyValue(TechnologicalInstanceDB to,TechnologyChange change){
   var p=to.Parameters.Find(change.Parameter);if(p==null)throw new RpcException(ErrorCodes.UnsupportedCapability,change.Parameter+": the technology object has no such parameter");
   if(!p.GetAttributeInfos().Any(i=>i.Name=="Value"&&i.AccessMode.ToString()=="ReadWrite"))throw new RpcException(ErrorCodes.UnsupportedCapability,change.Parameter+": TIA Portal does not let this parameter be written");
   var current=p.Value;var text=change.Value.Trim();var c=System.Globalization.CultureInfo.InvariantCulture;
   try{switch(current){
    case bool _:if(text.Equals("true",StringComparison.OrdinalIgnoreCase))return true;if(text.Equals("false",StringComparison.OrdinalIgnoreCase))return false;break;
    case float _:{var v=float.Parse(text,System.Globalization.NumberStyles.Float,c);if(!float.IsNaN(v)&&!float.IsInfinity(v))return v;break;}
    case double _:{var v=double.Parse(text,System.Globalization.NumberStyles.Float,c);if(!double.IsNaN(v)&&!double.IsInfinity(v))return v;break;}
    case sbyte _:case byte _:case short _:case ushort _:case int _:case uint _:case long _:case ulong _:return Convert.ChangeType(decimal.Parse(text,System.Globalization.NumberStyles.Integer,c),current.GetType(),c);
    case string _:return change.Value;
   }}catch(Exception e)when(e is FormatException||e is OverflowException){}
   throw new RpcException(ErrorCodes.BadRequest,change.Parameter+": "+change.Value+" is no valid "+(change.Datatype??current?.GetType().Name??"value")+" for this parameter");
  }
  static byte[] TechnologyBytes(TechnologicalInstanceDB to)=>NativeArtifactBytes(file=>to.Export(file,ExportOptions.WithDefaults,DocumentInfoOptions.None),".xml");
  static SortedDictionary<string,object> TechnologyValues(TechnologicalInstanceDB to){var result=new SortedDictionary<string,object>(StringComparer.Ordinal){["$name"]=to.Name,["$type"]=to.OfSystemLibElement,["$version"]=to.OfSystemLibVersion.ToString(),["$number"]=to.GetAttribute("Number"),["$autoNumber"]=to.GetAttribute("AutoNumber")};if(to.Parameters.Count>256)throw new RpcException(ErrorCodes.UnsupportedCapability,"Technology parameter limit exceeded");foreach(var p in to.Parameters){var value=p.Value;if(value is Enum)value=value.ToString();if(value!=null&&!(value is string)&&!value.GetType().IsPrimitive)throw new RpcException(ErrorCodes.UnsupportedCapability,"Nonprimitive technology parameter unavailable: "+p.Name);if(result.ContainsKey(p.Name))throw new RpcException(ErrorCodes.BadRequest,"Duplicate native parameter");result.Add(p.Name,value);}return result;}
  static string ValueHash(SortedDictionary<string,object> values)=>Bundle.Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(values,RpcWire.Json)));
  string ArtifactProjectRevision(string technologyName=null){var state=LibraryState();var tree=Describe("techobjects",4096);if(technologyName!=null){var removed=0;void Remove(DescribeNode node){if(node.Children==null)return;foreach(var key in node.Children.Keys.ToArray()){var children=node.Children[key];removed+=children.RemoveAll(n=>n.Type=="TechnologicalInstanceDB"&&n.Name==technologyName);foreach(var child in children)Remove(child);if(children.Count==0)node.Children.Remove(key);}}Remove(tree);if(removed!=1)throw new RpcException(ErrorCodes.UnsupportedCapability,"Technology identity must identify exactly one root object");foreach(var plc in Plcs())state.Objects.Remove(Addr(plc.Name,"block",new List<string>(),technologyName,null));}return Bundle.Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{project=LibraryImportPlan.Revision(state),technology=HardwarePlan.Revision(tree),languages=ArtifactLanguages()},RpcWire.Json)));}
  // a PLC without text lists yet starts from nothing in the proposed workbook's columns: its first lists are additions
  AlarmWorkbook CurrentAlarms(PlcSoftware plc,AlarmWorkbook proposed){var bytes=AlarmBytes(plc,proposed!=null);return bytes==null?AlarmWorkbook.Empty(proposed):AlarmWorkbook.Parse(bytes,ArtifactLanguages());}
  ArtifactState AlarmState(PlcSoftware plc,AlarmWorkbook proposed=null)=>new ArtifactState{ProjectRevision=ArtifactProjectRevision(),ContentRevision=CurrentAlarms(plc,proposed).Revision()};
  ArtifactState TechnologyState(PlcSoftware plc,string name)=>new ArtifactState{ProjectRevision=ArtifactProjectRevision(name),ContentRevision=ValueHash(TechnologyValues(Technology(plc,name)))};
  static string TechnologyRevision(ArtifactState state,byte[] source)=>Bundle.Sha256(Encoding.UTF8.GetBytes(ArtifactPlan.Revision(state)+":"+Bundle.Sha256(source)));
  public ArtifactExport ExportProjectArtifact(string kind,string device,string name){var plc=ArtifactPlc(kind,device,name);using(var access=_portal.ExclusiveAccess("rung: artifact export")){var bytes=kind=="alarms"?AlarmBytes(plc):TechnologyBytes(Technology(plc,name));var revision=kind=="alarms"?ArtifactPlan.Revision(AlarmState(plc)):TechnologyRevision(TechnologyState(plc,name),bytes);return new ArtifactExport{ContentBase64=Convert.ToBase64String(bytes),Revision=revision,ArtifactRevision=Bundle.Sha256(bytes),Languages=ArtifactLanguages()};}}
  ArtifactPreview ArtifactPreviewCore(string kind,PlcSoftware plc,string name,byte[] bytes){if(kind=="alarms"){var proposed=AlarmWorkbook.Parse(bytes,ArtifactLanguages());var current=CurrentAlarms(plc,proposed);return new ArtifactPreview{Revision=ArtifactPlan.Revision(new ArtifactState{ProjectRevision=ArtifactProjectRevision(),ContentRevision=current.Revision()}),ArtifactRevision=Bundle.Sha256(bytes),Changes=AlarmWorkbook.Preview(current,proposed)};}var source=TechnologyBytes(Technology(plc,name));if(TechnologyArtifact.Name(bytes)!=name)throw new RpcException(ErrorCodes.BadRequest,"Technology name differs");var changes=TechnologyArtifact.Preview(source,bytes);var to=Technology(plc,name);foreach(var change in changes)TechnologyValue(to,change);return new ArtifactPreview{Revision=TechnologyRevision(TechnologyState(plc,name),source),ArtifactRevision=Bundle.Sha256(bytes),Changes=changes.Cast<object>().ToArray()};}
  public ArtifactPreview PreviewProjectArtifact(string kind,string device,string name,byte[] bytes){var plc=ArtifactPlc(kind,device,name);using(var access=_portal.ExclusiveAccess("rung: artifact preview"))return ArtifactPreviewCore(kind,plc,name,bytes);}
  public ArtifactResult ImportProjectArtifact(string kind,string device,string name,byte[] bytes,string expectedRevision,string operationId){var plc=ArtifactPlc(kind,device,name);FixtureGuard.CheckImport(_args.AllowImport,_args.AllowFixtureImport,_project.Path.FullName);using(var access=_portal.ExclusiveAccess("rung: artifact import")){
   var preview=ArtifactPreviewCore(kind,plc,name,bytes);LibraryImportPlan.CheckRevision(expectedRevision);if(preview.Revision!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project/native artifact differs from preview");operationId=HardwarePlan.StartOperation(operationId,_libraryOperations,"Artifact");ArtifactResult result;_inImport=true;
   try{var dir=Path.Combine(Path.GetTempPath(),"rung-artifact-import-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);try{var file=new FileInfo(Path.Combine(dir,kind=="alarms"?"native.xlsx":"native.xml"));File.WriteAllBytes(file.FullName,bytes);Func<ArtifactState> read;string desired;
    if(kind=="alarms"){var proposed=AlarmWorkbook.Parse(bytes,ArtifactLanguages());read=()=>AlarmState(plc,proposed);desired=proposed.Revision();}
    else{read=()=>TechnologyState(plc,name);var to=Technology(plc,name);var values=TechnologyValues(to);foreach(TechnologyChange change in preview.Changes)values[change.Parameter]=TechnologyValue(to,change);desired=ValueHash(values);}
    var baseline=ArtifactPlan.Revision(read());result=new ArtifactResult{Revision=ArtifactPlan.Apply(read,baseline,desired,()=>{
     if(kind=="alarms"){var native=plc.GetService<PlcAlarmTextListProvider>().ImportFromXlsx(file,ImportOptions.Override);if(native.State.ToString()!="OK")throw new RpcException(ErrorCodes.ImportFailed,"Native alarm import warning/error refused");}
     else plc.TechnologicalObjectGroup.TechnologicalObjects.Import(file,ImportOptions.Override);
    },work=>{using(var tx=access.Transaction(_project,"rung artifact import "+operationId)){work();tx.CommitOnDispose();}})};
   }finally{Directory.Delete(dir,true);}}finally{_inImport=false;_index.Clear();_libraryTypes.Clear();}
   Receipts.Write(operationId,"artifact:"+_project.Path.FullName);if(_args.SaveAfterImport)try{_project.Save();result.Saved=true;}catch(EngineeringException){result.Warnings=new[]{WarningCodes.SaveFailed};}return result;
  }}
 }
}
