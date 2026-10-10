// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using System.Collections.Generic;
using System.Text.Json;
using System.Text;
using System.IO;
using System.Xml;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public sealed class LibraryReleaseRequest { public string TypeGuid,VersionGuid,VersionNumber,Author,Comment; }
    public sealed class LibraryReleasePreview { public LibraryReleaseRequest Request; public string Revision; public string[] Addresses; }
    public static class LibraryReleasePlan
    {
        public static string DefinitionHash(byte[] bytes) => DefinitionHash(bytes,false);
        public static string DefinitionHash(byte[] bytes,bool instantiated)
        {
            if(bytes==null||bytes.Length==0||bytes.Length>4*1048576)throw new RpcException(ErrorCodes.BadRequest,"Native library definition is missing or oversized");
            try {
                var doc=new XmlDocument { PreserveWhitespace=true,XmlResolver=null };
                using(var stream=new MemoryStream(bytes))using(var reader=XmlReader.Create(stream,new XmlReaderSettings { DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=4*1048576 }))doc.Load(reader);
                if(doc.DocumentElement?.Name!="Document"||doc.SelectSingleNode("/Document/Engineering/@version")?.Value!="V20")throw new XmlException("Expected native V20 document");
                var blocks=doc.SelectNodes("/Document/SW.Blocks.FB | /Document/SW.Blocks.CodeBlockLibraryTypeVersion/ObjectList/SW.Blocks.FB[@CompositionName='ContentObject']");
                if(blocks.Count!=1)throw new XmlException("Expected exactly one native FB definition");
                var block=(XmlElement)blocks[0];block.RemoveAttribute("CompositionName");
                if(instantiated)foreach(XmlNode identity in block.SelectNodes("AttributeList/Name | AttributeList/Number | AttributeList/AutoNumber"))identity.ParentNode.RemoveChild(identity);
                void Normalize(XmlElement element) {
                    if(element.HasAttribute("ID")) {
                        if(element.Name!="SW.Blocks.FB"&&element.Name!="SW.Blocks.CompileUnit"&&element.Name!="MultilingualText"&&element.Name!="MultilingualTextItem")throw new XmlException("Unproved native ID node");
                        element.RemoveAttribute("ID");
                    }
                    if(element.HasAttribute("RefId"))throw new XmlException("Unproved native object reference");
                    var hasElements=element.ChildNodes.Cast<XmlNode>().Any(n=>n is XmlElement);
                    foreach(var child in element.ChildNodes.Cast<XmlNode>().ToArray()) {
                        if(child is XmlElement nested)Normalize(nested);
                        else if(hasElements&&(child is XmlWhitespace||child is XmlSignificantWhitespace))element.RemoveChild(child);
                    }
                }
                Normalize(block);return Bundle.Sha256(Encoding.UTF8.GetBytes(block.OuterXml));
            } catch(XmlException error) { throw new RpcException(ErrorCodes.BadRequest,"Unsupported native library definition: "+error.Message); }
        }
        public static void Check(LibraryReleaseRequest request)
        {
            if(request==null || !Guid.TryParseExact(request.TypeGuid,"D",out var type) || type==Guid.Empty
                || !Guid.TryParseExact(request.VersionGuid,"D",out var version) || version==Guid.Empty
                || request.VersionNumber==null || !Regex.IsMatch(request.VersionNumber,@"^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$")
                || request.VersionNumber=="0.0.0" || string.IsNullOrWhiteSpace(request.Author) || request.Author.Length>128
                || request.Author.Any(char.IsControl) || request.Comment==null || request.Comment.Length>4096 || request.Comment.IndexOf('\0')>=0)
                throw new RpcException(ErrorCodes.BadRequest,"Release requires type/version UUIDs, a canonical version, author and bounded comment");
        }
        static void RemoveType(DescribeNode node,string guid,ref int count)
        {
            if(node.Children==null)return;
            foreach(var children in node.Children.Values) {
                count+=children.RemoveAll(n=>n.Attributes!=null&&n.Attributes.TryGetValue("Guid",out var value)&&value==guid);
                foreach(var child in children)RemoveType(child,guid,ref count);
            }
        }
        static string OutsideType(LibraryImportState state,string guid,string oldVersion=null,string newVersion=null)
        {
            LibraryImportPlan.Revision(state);
            var copy=new LibraryImportState { Libraries=HardwarePlan.Copy(state.Libraries),Hardware=HardwarePlan.Copy(state.Hardware),Objects=new SortedDictionary<string,string>(state.Objects,StringComparer.Ordinal) };
            if(newVersion!=null)foreach(var key in copy.Objects.Keys.ToArray()) {
                using(var doc=JsonDocument.Parse(copy.Objects[key])) {
                    if(doc.RootElement.TryGetProperty("libraryTypeGuid",out var type)&&type.GetString()==guid
                        && doc.RootElement.TryGetProperty("libraryVersionGuid",out var version)&&version.GetString()==newVersion)
                        copy.Objects[key]=copy.Objects[key].Replace("\"libraryVersionGuid\":\""+newVersion+"\"","\"libraryVersionGuid\":\""+oldVersion+"\"").Replace("\"isConsistent\":false","\"isConsistent\":true");
                }
            }
            var count=0;RemoveType(copy.Libraries,guid,ref count);
            if(count!=1)throw new RpcException(ErrorCodes.ImportFailed,"Release target must identify exactly one project type");
            return LibraryImportPlan.Revision(copy);
        }
        // ponytail: initial single-version release keeps every project object; edited test environments refuse.
        public static LibraryImportResult Apply(Func<LibraryImportState> read,LibraryReleaseRequest request,string expectedRevision,Func<string> release,Action<Action> transaction)
        {
            Check(request);LibraryImportPlan.CheckRevision(expectedRevision);
            var before=read();var revision=LibraryImportPlan.Revision(before);
            if(revision!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project changed since the library release preview");
            var outside=OutsideType(before,request.TypeGuid);string validated=null,releasedGuid=null;
            void Verify(LibraryImportState state) { if(OutsideType(state,request.TypeGuid,request.VersionGuid,releasedGuid)!=outside)throw new RpcException(ErrorCodes.ImportFailed,"Release changed unreviewed project objects"); }
            try {
                transaction(()=>{releasedGuid=release();if(!Guid.TryParseExact(releasedGuid,"D",out var id)||id==Guid.Empty)throw new RpcException(ErrorCodes.ImportFailed,"Release returned an invalid native version identity");var actual=read();Verify(actual);validated=LibraryImportPlan.Revision(actual);});
                var after=read();Verify(after);var current=LibraryImportPlan.Revision(after);
                if(current!=validated)throw new RpcException(ErrorCodes.ImportFailed,"Commit changed the validated release state");
                return new LibraryImportResult { TypeGuid=request.TypeGuid,VersionGuid=releasedGuid,VersionNumber=request.VersionNumber,State="Committed",Revision=current };
            } catch(Exception error) {
                try { if(LibraryImportPlan.Revision(read())!=revision)throw new InvalidOperationException("Original project state differs"); }
                catch(Exception restoration) { throw new RpcException(ErrorCodes.ImportFailed,"RESTORATION FAILED after library release: "+restoration.Message+"; original error: "+error.Message); }
                throw new RpcException(ErrorCodes.ImportFailed,"Library release refused; original state restored: "+error.Message);
            }
        }
    }
}
