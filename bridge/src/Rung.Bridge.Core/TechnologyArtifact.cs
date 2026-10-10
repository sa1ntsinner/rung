// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 /// <summary>One start value of a technology object's parameter, as the edited native XML sets it (path as the TO API names it: Config.InputUpperLimit).</summary>
 public sealed class TechnologyChange { public string Name,Parameter,Datatype,Value; }
 public static class TechnologyArtifact {
  static RpcException Bad(string message)=>new RpcException(ErrorCodes.BadRequest,"Technology artifact: "+message);
  static XmlDocument Parse(byte[] bytes){if(bytes==null||bytes.Length<1||bytes.Length>4*1048576)throw Bad("missing/oversized XML");try{var doc=new XmlDocument{XmlResolver=null};using(var stream=new MemoryStream(bytes))using(var reader=XmlReader.Create(stream,new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=4*1048576}))doc.Load(reader);if(doc.SelectSingleNode("/Document/Engineering/@version")?.Value!="V20"||doc.SelectNodes("/Document/SW.TechnologicalObjects.TechnologicalInstanceDB").Count!=1||doc.DocumentElement.ChildNodes.Cast<XmlNode>().Any(n=>n.Name!="Engineering"&&n.Name!="SW.TechnologicalObjects.TechnologicalInstanceDB"))throw Bad("expected one native V20 TO");return doc;}catch(XmlException e){throw Bad(e.Message);}}
  public static string Name(byte[] bytes)=>Parse(bytes).SelectSingleNode("/Document/SW.TechnologicalObjects.TechnologicalInstanceDB/AttributeList/Name")?.InnerText??throw Bad("missing object name");
  // Member names from the interface section down: Config / InputUpperLimit → Config.InputUpperLimit
  static string PathOf(XmlElement member){var names=new List<string>();for(XmlNode n=member;n!=null;n=n.ParentNode)if(n is XmlElement e&&e.LocalName=="Member")names.Insert(0,e.GetAttribute("Name"));return string.Join(".",names);}
  static Dictionary<string,(string Datatype,string Value)> StartValues(XmlDocument doc){
   var result=new Dictionary<string,(string,string)>(StringComparer.Ordinal);
   foreach(var member in doc.SelectNodes("//*[local-name()='Member']").Cast<XmlElement>()){
    var values=member.ChildNodes.Cast<XmlNode>().Where(n=>n.LocalName=="StartValue").ToArray();if(values.Length>1)throw Bad("duplicate StartValue");
    var path=PathOf(member);if(result.ContainsKey(path))throw Bad("duplicate member "+path);result.Add(path,(member.GetAttribute("Datatype"),values.Length==1?values[0].InnerText:null));
   }
   return result;
  }
  static string Shape(XmlDocument doc){var copy=(XmlDocument)doc.Clone();foreach(var node in copy.SelectNodes("//*[local-name()='StartValue']").Cast<XmlNode>().ToArray()){var parent=(XmlElement)node.ParentNode;parent.RemoveChild(node);if(!parent.HasChildNodes)parent.IsEmpty=true;}return copy.OuterXml;}
  /// <summary>Every start value the edited XML sets differently; everything else (identity, members, attributes) must stay as exported.</summary>
  public static TechnologyChange[] Preview(byte[] original,byte[] proposed){
   var a=Parse(original);var b=Parse(proposed);
   if(Shape(a)!=Shape(b))throw Bad("identity or unreviewed native fields changed");
   var before=StartValues(a);var name=Name(original);var changes=new List<TechnologyChange>();
   foreach(var pair in StartValues(b)){
    var old=before[pair.Key];if(old.Value==pair.Value.Value)continue;
    // an absent start value means the native default, which the export does not show
    if(pair.Value.Value==null)throw Bad(pair.Key+": removing a start value resets it to a default the export does not show; set the value instead");
    changes.Add(new TechnologyChange{Name=name,Parameter=pair.Key,Datatype=pair.Value.Datatype,Value=pair.Value.Value});
   }
   return changes.ToArray();
  }
 }
}
