// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Linq;
using System.Xml;
using System.Globalization;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 public sealed class TechnologyChange { public string Name,Parameter="Config.InputUpperLimit";public float Value;public bool ImplicitDefault; }
 public static class TechnologyArtifact {
  const string Member="//*[local-name()='Member' and @Name='Config']/*[local-name()='Sections']/*[local-name()='Section']/*[local-name()='Member' and @Name='InputUpperLimit' and @Datatype='Real']";
  static RpcException Bad(string message)=>new RpcException(ErrorCodes.BadRequest,"Technology artifact: "+message);
  static XmlDocument Parse(byte[] bytes){if(bytes==null||bytes.Length<1||bytes.Length>4*1048576)throw Bad("missing/oversized XML");try{var doc=new XmlDocument{XmlResolver=null};using(var stream=new MemoryStream(bytes))using(var reader=XmlReader.Create(stream,new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=4*1048576}))doc.Load(reader);if(doc.SelectSingleNode("/Document/Engineering/@version")?.Value!="V20"||doc.SelectNodes("/Document/SW.TechnologicalObjects.TechnologicalInstanceDB").Count!=1||doc.DocumentElement.ChildNodes.Cast<XmlNode>().Any(n=>n.Name!="Engineering"&&n.Name!="SW.TechnologicalObjects.TechnologicalInstanceDB"))throw Bad("expected one native V20 TO");var attrs=doc.SelectSingleNode("/Document/SW.TechnologicalObjects.TechnologicalInstanceDB/AttributeList");if(attrs?.SelectSingleNode("OfSystemLibElement")?.InnerText!="PID_Compact"||attrs.SelectSingleNode("OfSystemLibVersion")?.InnerText!="2.3"||doc.SelectNodes(Member).Count!=1)throw Bad("only observed PID_Compact2.3 parameter layout is supported");return doc;}catch(XmlException e){throw Bad(e.Message);}}
  public static string Name(byte[] bytes)=>Parse(bytes).SelectSingleNode("/Document/SW.TechnologicalObjects.TechnologicalInstanceDB/AttributeList/Name")?.InnerText??throw Bad("missing object name");
  public static TechnologyChange Preview(byte[] original,byte[] proposed){var a=Parse(original);var b=Parse(proposed);var member=b.SelectSingleNode(Member);var values=member.SelectNodes("*[local-name()='StartValue']");if(values.Count>1)throw Bad("duplicate StartValue");var value=120f; // Native V20 PID_Compact2.3 implicit default observed on the offline fixture.
   if(values.Count==1&&(!float.TryParse(values[0].InnerText,NumberStyles.Float,CultureInfo.InvariantCulture,out value)||float.IsNaN(value)||float.IsInfinity(value)))throw Bad("finite Real value required");
   foreach(var doc in new[]{a,b}){var input=doc.SelectSingleNode(Member);foreach(XmlNode node in input.SelectNodes("*[local-name()='StartValue']"))node.ParentNode.RemoveChild(node);if(!input.HasChildNodes)((XmlElement)input).IsEmpty=true;}
   if(a.OuterXml!=b.OuterXml)throw Bad("identity or unreviewed native fields changed");return new TechnologyChange{Name=Name(original),Value=value,ImplicitDefault=values.Count==0};
  }
 }
}
