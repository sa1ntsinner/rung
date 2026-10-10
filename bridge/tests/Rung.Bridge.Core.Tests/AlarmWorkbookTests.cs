// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;
public class AlarmWorkbookTests {
 static byte[] Native()=>File.ReadAllBytes(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Fixtures","alarms-v20.xlsx"));
 static byte[] Changed(string from,string to){using(var input=new MemoryStream(Native()))using(var zip=new ZipArchive(input,ZipArchiveMode.Read))using(var output=new MemoryStream()){using(var target=new ZipArchive(output,ZipArchiveMode.Create,true))foreach(var e in zip.Entries){var c=target.CreateEntry(e.FullName);using(var read=new StreamReader(e.Open()))using(var write=new StreamWriter(c.Open(),new UTF8Encoding(false)))write.Write(read.ReadToEnd().Replace(from,to));}return output.ToArray();}}
 [Fact]public void NativeWorkbookPreservesIdentityAndAcceptsOnlyTextChanges(){var original=AlarmWorkbook.Parse(Native(),new[]{"en-US"});Assert.Single(original.Lists);Assert.Single(original.Entries);var changes=AlarmWorkbook.Preview(original,AlarmWorkbook.Parse(Changed("Stopped","Running"),new[]{"en-US"}));Assert.Single(changes);Assert.Throws<RpcException>(()=>AlarmWorkbook.Preview(original,AlarmWorkbook.Parse(Changed("RungAlarmProbe","Other"),new[]{"en-US"})));}
 static string Row(int r,params string[] values){var cells=new StringBuilder();for(var i=0;i<values.Length;i++)cells.Append($"<x:c r=\"{(char)('A'+i)}{r}\" t=\"inlineStr\"><x:is><x:t>{values[i]}</x:t></x:is></x:c>");return $"<x:row r=\"{r}\">{cells}</x:row>";}
 const string LastEntry="<x:v>12</x:v></x:c></x:row>",LastList="<x:v>9</x:v></x:c></x:row>";
 static AlarmWorkbook Parsed(byte[] bytes)=>AlarmWorkbook.Parse(bytes,new[]{"en-US"});
 [Fact]public void NewEntriesAndNewListsAreAddedWhileExistingOnesStay(){
  var original=Parsed(Native());
  var entry=Parsed(Changed(LastEntry,LastEntry+Row(3,"RungAlarmProbe","2","3","Fault")));
  var change=Assert.Single(AlarmWorkbook.Preview(original,entry));
  Assert.Contains("\"added\":true",System.Text.Json.JsonSerializer.Serialize(change));
  Assert.Contains("Fault",System.Text.Json.JsonSerializer.Serialize(change));
  var list=Parsed(Changed(LastList,LastList+Row(3,"RungModes","Decimal","Operating modes")));
  Assert.Single(AlarmWorkbook.Preview(original,list));
  // an entry for a list that is new too
  Assert.Throws<RpcException>(()=>Parsed(Changed(LastEntry,LastEntry+Row(3,"RungModes","0","0","Auto"))));
  // a removed entry or a changed range is no addition: refused
  Assert.Throws<RpcException>(()=>AlarmWorkbook.Preview(entry,original));
  Assert.Throws<RpcException>(()=>AlarmWorkbook.Preview(original,Parsed(Changed("<x:v>11</x:v>","<x:v>10</x:v>"))));
 }
 [Fact]public void APlcWithoutListsStartsFromNothingAndRevisionsIgnoreRowOrder(){
  var proposed=Parsed(Native());
  var empty=AlarmWorkbook.Empty(proposed);
  Assert.Empty(empty.Lists);Assert.Equal(2,AlarmWorkbook.Preview(empty,proposed).Length);
  var a=Parsed(Changed(LastEntry,LastEntry+Row(3,"RungAlarmProbe","2","3","Fault")));
  var b=new AlarmWorkbook{ListHeaders=a.ListHeaders,EntryHeaders=a.EntryHeaders,Lists=a.Lists,Entries=new[]{a.Entries[1],a.Entries[0]}};
  // TIA exports entries in its own order: the same entries are the same state
  Assert.Equal(a.Revision(),b.Revision());
 }
 [Fact]public void RefusesUnknownLanguagesDuplicateRowsAndDamagedZip(){Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Native(),new[]{"de-DE"}));Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Changed("<x:row r=\"2\">","<x:row r=\"1\">"),new[]{"en-US"}));Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Encoding.UTF8.GetBytes("broken"),new[]{"en-US"}));}
 [Theory][InlineData("xl/styles.xml")][InlineData("[Content_Types].xml")][InlineData("_rels/.rels")]
 public void RefusesMissingNativePackagePart(string omitted){using(var input=new MemoryStream(Native()))using(var zip=new ZipArchive(input,ZipArchiveMode.Read))using(var output=new MemoryStream()){using(var target=new ZipArchive(output,ZipArchiveMode.Create,true))foreach(var entry in zip.Entries){if(entry.FullName==omitted)continue;using(var source=entry.Open())using(var dest=target.CreateEntry(entry.FullName).Open())source.CopyTo(dest);}Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(output.ToArray(),new[]{"en-US"}));}}
 [Fact]public void RefusesInvalidStyleAndHiddenDtd(){Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Changed("s=\"0\"","s=\"999\""),new[]{"en-US"}));Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Changed("<x:styleSheet","<!DOCTYPE styleSheet [<!ENTITY x 'hidden'>]><x:styleSheet"),new[]{"en-US"}));}
 [Fact]public void RefusesBrokenWorksheetRelationship(){Assert.Throws<RpcException>(()=>AlarmWorkbook.Parse(Changed("Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\"",""),new[]{"en-US"}));}
}
