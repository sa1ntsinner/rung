// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 public sealed class AlarmWorkbook {
  public string[] ListHeaders,EntryHeaders;public string[][] Lists,Entries;
  static RpcException Bad(string message)=>new RpcException(ErrorCodes.BadRequest,"Alarm workbook: "+message);
  static XmlDocument Xml(ZipArchiveEntry entry){if(entry==null||entry.Length>4*1048576)throw Bad("missing/oversized XML part");var doc=new XmlDocument{XmlResolver=null};using(var stream=entry.Open())using(var reader=XmlReader.Create(stream,new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=4*1048576}))doc.Load(reader);return doc;}
  static XmlNode[] Nodes(XmlNode node,string path)=>node.SelectNodes(path).Cast<XmlNode>().ToArray();
  public static AlarmWorkbook Parse(byte[] bytes,string[] activeLanguages){
   if(bytes==null||bytes.Length<1||bytes.Length>4*1048576||activeLanguages==null||activeLanguages.Length>32)throw Bad("missing/oversized artifact or languages");
   try{using(var stream=new MemoryStream(bytes))using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)){
    if(zip.Entries.Count>64||zip.Entries.Any(e=>e.Length>4*1048576||e.FullName.Contains("..")||e.FullName.Contains("\\")||e.FullName.StartsWith("/",StringComparison.Ordinal)||!Regex.IsMatch(e.FullName,@"^[A-Za-z0-9_./\[\]-]+$")||!(e.FullName.EndsWith(".xml",StringComparison.Ordinal)||e.FullName.EndsWith(".rels",StringComparison.Ordinal)))||zip.Entries.Sum(e=>e.Length)>16*1048576||zip.Entries.Select(e=>e.FullName).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=zip.Entries.Count)throw Bad("unsupported ZIP parts/size/duplicates");
    // Every package part reaches native import, including parts outside the two data sheets.
    foreach(var part in zip.Entries){if(!Regex.IsMatch(part.FullName,@"^(\[Content_Types\]\.xml|_rels/\.rels|docProps/(custom|core|app)\.xml|xl/(workbook|styles|sharedStrings)\.xml|xl/_rels/workbook\.xml\.rels|xl/worksheets/sheet[0-9]*\.xml)$"))throw Bad("unsupported package part");Xml(part);}
    if(Xml(zip.GetEntry("[Content_Types].xml")).DocumentElement?.LocalName!="Types"||Xml(zip.GetEntry("_rels/.rels")).DocumentElement?.LocalName!="Relationships")throw Bad("invalid package roots");
    var styles=Xml(zip.GetEntry("xl/styles.xml"));if(styles.DocumentElement?.LocalName!="styleSheet")throw Bad("invalid style root");var styleCount=Nodes(styles,"/*[local-name()='styleSheet']/*[local-name()='cellXfs']/*[local-name()='xf']").Length;if(styleCount<1||styleCount>256)throw Bad("unsupported styles");
    foreach(var rel in zip.Entries.Where(e=>e.FullName.EndsWith(".rels",StringComparison.Ordinal))){var relationships=Nodes(Xml(rel),"//*[local-name()='Relationship']");if(relationships.Select(r=>r.Attributes["Id"]?.Value).Distinct(StringComparer.Ordinal).Count()!=relationships.Length)throw Bad("duplicate relationships");foreach(var r in relationships){var target=r.Attributes["Target"]?.Value;var type=r.Attributes["Type"]?.Value;if(r.Attributes["TargetMode"]!=null||string.IsNullOrEmpty(target)||target.Contains("..")||string.IsNullOrEmpty(type)||string.IsNullOrEmpty(r.Attributes["Id"]?.Value))throw Bad("invalid/external/traversing relationship");var path=target.StartsWith("/",StringComparison.Ordinal)?target.Substring(1):(rel.FullName=="_rels/.rels"?"":"xl/")+target;if(zip.GetEntry(path)==null)throw Bad("missing relationship target");}}
    var props=Nodes(Xml(zip.GetEntry("docProps/custom.xml")),"//*[local-name()='property']");
    if(props.Length!=2||props.Count(p=>p.Attributes["name"]?.Value=="FileContent"&&p.InnerText=="Alarm text lists")!=1||props.Count(p=>p.Attributes["name"]?.Value=="FileVersion"&&p.InnerText=="1")!=1)throw Bad("unsupported native file properties");
    var strings=zip.GetEntry("xl/sharedStrings.xml")==null?Array.Empty<string>():Nodes(Xml(zip.GetEntry("xl/sharedStrings.xml")),"//*[local-name()='si']").Select(si=>{if(si.ChildNodes.Cast<XmlNode>().Any(n=>n.LocalName!="t"))throw Bad("rich shared strings unavailable");return si.InnerText;}).ToArray();
    if(strings.Length>65536||strings.Any(s=>s.Length>4096))throw Bad("oversized shared strings");
    var workbook=Xml(zip.GetEntry("xl/workbook.xml"));if(Nodes(workbook,"//*[local-name()='definedName' or local-name()='externalReference']").Length!=0)throw Bad("defined names/external references unavailable");
    var sheets=Nodes(workbook,"//*[local-name()='sheets']/*[local-name()='sheet']");if(sheets.Length!=2||sheets.Select(s=>s.Attributes["name"]?.Value).OrderBy(s=>s,StringComparer.Ordinal).SequenceEqual(new[]{"TextList","TextListEntry"})==false)throw Bad("expected two native sheets");
    var relations=Nodes(Xml(zip.GetEntry("xl/_rels/workbook.xml.rels")),"//*[local-name()='Relationship']");
    string[][] Read(string name){var sheet=sheets.Single(s=>s.Attributes["name"].Value==name);var id=sheet.Attributes.Cast<XmlAttribute>().Single(a=>a.LocalName=="id").Value;
     var rel=relations.Single(r=>r.Attributes["Id"]?.Value==id);if(!rel.Attributes["Type"].Value.EndsWith("/worksheet",StringComparison.Ordinal))throw Bad("invalid sheet relationship");var target=rel.Attributes["Target"].Value;var path=target.StartsWith("/",StringComparison.Ordinal)?target.Substring(1):"xl/"+target;if(!path.StartsWith("xl/worksheets/",StringComparison.Ordinal))throw Bad("unexpected sheet path");
     var doc=Xml(zip.GetEntry(path));if(Nodes(doc,"//*[local-name()='f' or local-name()='hyperlink' or local-name()='mergeCell']").Length!=0)throw Bad("formulas/links/merged cells unavailable");
     var rows=Nodes(doc,"//*[local-name()='sheetData']/*[local-name()='row']");if(rows.Length<1||rows.Length>10001)throw Bad("row limit");var result=new List<string[]>();int columns=0;
     for(int rowIndex=0;rowIndex<rows.Length;rowIndex++){var row=rows[rowIndex];if(row.Attributes["r"]?.Value!=(rowIndex+1).ToString(System.Globalization.CultureInfo.InvariantCulture))throw Bad("duplicate/missing/reordered row");var cells=Nodes(row,"*[local-name()='c']");if(rowIndex==0)columns=cells.Length;if(columns<3||columns>35||cells.Length>columns)throw Bad("column limit");var values=Enumerable.Repeat("",columns).ToArray();var seen=new HashSet<int>();
      foreach(var cell in cells){var style=cell.Attributes["s"]?.Value;if(style!=null&&(!int.TryParse(style,out var styleIndex)||styleIndex<0||styleIndex>=styleCount))throw Bad("invalid cell style");var address=cell.Attributes["r"]?.Value;var match=Regex.Match(address??"",@"^([A-Z]{1,2})([1-9][0-9]{0,4})$");if(!match.Success||match.Groups[2].Value!=(rowIndex+1).ToString())throw Bad("cell identity");var col=0;foreach(var c in match.Groups[1].Value)col=col*26+c-'A'+1;col--;if(col>=columns||!seen.Add(col))throw Bad("duplicate/outside cell");var kind=cell.Attributes["t"]?.Value;var v=cell.SelectSingleNode("*[local-name()='v']")?.InnerText??"";
       if(kind=="s"){if(!int.TryParse(v,out var index)||index<0||index>=strings.Length)throw Bad("shared string index");v=strings[index];}
       else if(kind=="inlineStr"){var item=cell.SelectSingleNode("*[local-name()='is']");if(item==null||item.ChildNodes.Cast<XmlNode>().Any(n=>n.LocalName!="t"))throw Bad("rich inline strings unavailable");v=item.InnerText;}
       else if(kind!=null&&kind!="n"&&kind!="str")throw Bad("unsupported cell type");if(v.Length>4096||v.IndexOf('\0')>=0)throw Bad("oversized cell");values[col]=v;
      }result.Add(values);
     }return result.ToArray();
    }
    var lists=Read("TextList");var entries=Read("TextListEntry");var result=new AlarmWorkbook{ListHeaders=lists[0],EntryHeaders=entries[0],Lists=lists.Skip(1).ToArray(),Entries=entries.Skip(1).ToArray()};
    void Headers(string[] headers,string[] identity,string prefix){if(headers.Take(identity.Length).SequenceEqual(identity)==false||headers.Distinct(StringComparer.Ordinal).Count()!=headers.Length)throw Bad("duplicate/unknown headers");foreach(var header in headers.Skip(identity.Length)){var match=Regex.Match(header,"^"+prefix+@" \[([^\]]+)\]$");if(!match.Success||!activeLanguages.Contains(match.Groups[1].Value,StringComparer.Ordinal))throw Bad("unknown/inactive language");}}
    Headers(result.ListHeaders,new[]{"Name","ListRange"},"Comment");Headers(result.EntryHeaders,new[]{"Parent","From","To"},"Text");
    if(result.Lists.Length==0||result.Lists.Any(r=>string.IsNullOrWhiteSpace(r[0])||r[0].Length>128||r[0].Any(char.IsControl)||r[1]!="Decimal")||result.Lists.Select(r=>r[0]).Distinct(StringComparer.Ordinal).Count()!=result.Lists.Length)throw Bad("duplicate/unsupported list identity/range");
    var ranges=new Dictionary<string,List<(ulong from,ulong to)>>(StringComparer.Ordinal);foreach(var entry in result.Entries){if(!result.Lists.Any(r=>r[0]==entry[0])||!Regex.IsMatch(entry[1],@"^(0|[1-9][0-9]{0,19})$")||!Regex.IsMatch(entry[2],@"^(0|[1-9][0-9]{0,19})$")||!ulong.TryParse(entry[1],out var from)||!ulong.TryParse(entry[2],out var to)||from>to)throw Bad("invalid entry identity/range");if(!ranges.TryGetValue(entry[0],out var group))ranges.Add(entry[0],group=new List<(ulong,ulong)>());if(group.Any(r=>r.from<=to&&from<=r.to))throw Bad("duplicate/overlapping entry range");group.Add((from,to));}
    return result;
   }}catch(RpcException){throw;}catch(Exception error)when(error is InvalidDataException||error is XmlException||error is InvalidOperationException||error is ArgumentException){throw Bad("damaged/unsupported XLSX: "+error.Message);}
  }
  /// <summary>A PLC without text lists: nothing yet, in the columns of the workbook that creates the first lists.</summary>
  public static AlarmWorkbook Empty(AlarmWorkbook proposed)=>new AlarmWorkbook{ListHeaders=proposed.ListHeaders,EntryHeaders=proposed.EntryHeaders,Lists=new string[0][],Entries=new string[0][]};
  static string ListKey(string[] row)=>row[0];
  static string EntryKey(string[] row)=>row[0]+"\n"+row[1]+"\n"+row[2];
  // TIA exports rows in its own order: the same lists and entries are the same state
  public string Revision()=>Bundle.Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new AlarmWorkbook{ListHeaders=ListHeaders,EntryHeaders=EntryHeaders,
   Lists=Lists.OrderBy(ListKey,StringComparer.Ordinal).ToArray(),Entries=Entries.OrderBy(r=>r[0],StringComparer.Ordinal).ThenBy(r=>ulong.Parse(r[1],System.Globalization.CultureInfo.InvariantCulture)).ThenBy(r=>r[2],StringComparer.Ordinal).ToArray()},RpcWire.Json)));
  /// <summary>Text and comment edits of existing rows, and new lists and entries; deleting rows or changing a range refuses.</summary>
  public static object[] Preview(AlarmWorkbook original,AlarmWorkbook proposed){var changes=new List<object>();
   void Compare(string sheet,string[] aHeaders,string[] bHeaders,string[][] a,string[][] b,int identity,Func<string[],string> key){
    if(!aHeaders.SequenceEqual(bHeaders))throw Bad("headers changed; export the complete existing lists");
    var proposedRows=new Dictionary<string,int>(StringComparer.Ordinal);for(var row=0;row<b.Length;row++)proposedRows[key(b[row])]=row;
    foreach(var old in a){if(!proposedRows.TryGetValue(key(old),out var row))throw Bad("a list or entry was deleted or its identity/range changed; only additions and text edits apply");
     for(var col=identity;col<aHeaders.Length;col++)if(old[col]!=b[row][col])changes.Add(new{sheet,row=row+2,column=aHeaders[col],original=old[col],proposed=b[row][col]});}
    var existing=new HashSet<string>(a.Select(key),StringComparer.Ordinal);
    for(var row=0;row<b.Length;row++)if(!existing.Contains(key(b[row]))){var values=new Dictionary<string,string>(StringComparer.Ordinal);for(var col=0;col<bHeaders.Length;col++)values[bHeaders[col]]=b[row][col];changes.Add(new{sheet,row=row+2,added=true,values});}
   }
   Compare("TextList",original.ListHeaders,proposed.ListHeaders,original.Lists,proposed.Lists,2,ListKey);Compare("TextListEntry",original.EntryHeaders,proposed.EntryHeaders,original.Entries,proposed.Entries,3,EntryKey);return changes.ToArray();
  }
 }
}
