// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class LibraryPackageTests
{
    static Dictionary<string, byte[]> Package()
    {
        var xml = new UTF8Encoding(true).GetPreamble();
        var body = Encoding.UTF8.GetBytes("<Document><Engineering version=\"V20\"/><SW.Blocks.FB ID=\"0\"><AttributeList><Name>Fx_LadEdges</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList></SW.Blocks.FB></Document>");
        var bytes = new byte[xml.Length + body.Length]; xml.CopyTo(bytes, 0); body.CopyTo(bytes, xml.Length);
        var hash = Convert.ToBase64String(HexBytes(Bundle.Sha256(bytes)));
        var meta = JsonSerializer.Serialize(new {
            DocumentHash = new[] { new { FileName = "type.xml", Hash = hash } }, LibraryMetaFileHash = hash,
            LibraryType = new { Guid = "b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e", DoNotUse = false, Comment = new Dictionary<string,string> { ["en-US"] = "" } },
            LibraryVersion = new { Guid = "51acffde-45c4-45db-a591-a5840bb011af", VersionNumber = "1.0.0", Author = "smile", IsDefault = true, InWork = false,
                Comment = new Dictionary<string,string> { ["en-US"] = "proof" }, MinimumTargetDeviceVersion = "", DependsOn = new object[0] } });
        return new Dictionary<string, byte[]> { ["type.xml"] = bytes, ["type.libinfo"] = Encoding.UTF8.GetBytes(meta) };
    }
    static byte[] HexBytes(string hex) { var bytes = new byte[hex.Length / 2]; for (var i=0;i<bytes.Length;i++) bytes[i]=Convert.ToByte(hex.Substring(i*2,2),16);return bytes; }
    [Fact] public void ValidatesNativeMetadataAndRawBomHashWithoutRewritingFiles()
    {
        var files = Package(); var original = (byte[])files["type.xml"].Clone();
        var result = LibraryPackage.Check(files, "type");
        Assert.Equal("Fx_LadEdges", result.TypeName); Assert.Equal("1.0.0", result.VersionNumber);
        Assert.Equal("51acffde-45c4-45db-a591-a5840bb011af", result.SourceVersionGuid);
        Assert.Equal(Bundle.Hash(new[] { new ExportFile { Role = "xml", Sha256 = Bundle.Sha256(files["type.xml"]) },
            new ExportFile { Role = "libinfo", Sha256 = Bundle.Sha256(files["type.libinfo"]) } }), result.Revision);
        Assert.Equal(original, files["type.xml"]);
        files["type.xml"] = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(original).TrimStart('\uFEFF'));
        Assert.Throws<RpcException>(() => LibraryPackage.Check(files, "type"));
    }
    [Fact] public void RefusesTamperingTraversalDependenciesDuplicateFieldsAndUnreleasedMetadata()
    {
        var valid = Package(); var meta = Encoding.UTF8.GetString(valid["type.libinfo"]);
        foreach(var changed in new[] { meta.Replace("type.xml", "../type.xml"), meta.Replace("\"DependsOn\":[]", "\"DependsOn\":[{}]"),
            meta.Replace("\"InWork\":false", "\"InWork\":true"), meta.Replace("\"VersionNumber\":\"1.0.0\"", "\"VersionNumber\":\"invalid\""),
            meta.Replace("\"DocumentHash\":", "\"DocumentHash\":[],\"DocumentHash\":"), meta.Replace("\"DoNotUse\":false", "\"DoNotUse\":true") })
        {
            var files = Package(); files["type.libinfo"] = Encoding.UTF8.GetBytes(changed);
            Assert.Throws<RpcException>(() => LibraryPackage.Check(files, "type"));
        }
        var extra = Package(); extra["TYPE.XML"] = extra["type.xml"]; Assert.Throws<RpcException>(() => LibraryPackage.Check(extra, "type"));
        var large = Package(); large["type.xml"] = new byte[4*1024*1024+1]; Assert.Throws<RpcException>(() => LibraryPackage.Check(large, "type"));
        Assert.Throws<RpcException>(() => LibraryPackage.Check(Package(), "../type"));
    }
    [Fact] public void RefusesExtraNativeObjectsEvenWhenTheirRawHashIsValid()
    {
        var files = Package(); var original = Encoding.UTF8.GetString(files["type.xml"]);
        var changed = Encoding.UTF8.GetBytes(original.Replace("</Document>", "<SW.Blocks.DB ID=\"2\"/></Document>"));
        var oldHash = Convert.ToBase64String(HexBytes(Bundle.Sha256(files["type.xml"])));
        var newHash = Convert.ToBase64String(HexBytes(Bundle.Sha256(changed)));
        files["type.libinfo"] = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(files["type.libinfo"]).Replace(oldHash, newHash));
        files["type.xml"] = changed;
        Assert.Throws<RpcException>(() => LibraryPackage.Check(files, "type"));
    }
    [Fact] public void RpcInspectionPreservesBytesAndNeverOpensAProject()
    {
        var opened = false; var dispatcher = new RpcDispatcher(() => { opened = true; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        var files = Package();
        var request = JsonSerializer.Serialize(new { id = 1, method = "library.inspect", @params = new { stem = "type", files = new[] {
            new { name = "type.xml", contentBase64 = Convert.ToBase64String(files["type.xml"]) }, new { name = "type.libinfo", contentBase64 = Convert.ToBase64String(files["type.libinfo"]) } } } });
        var reply = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
        Assert.True(reply.TryGetProperty("result", out var result), reply.ToString());
        Assert.Equal("Fx_LadEdges", result.GetProperty("typeName").GetString()); Assert.False(opened);
        var malformed = JsonDocument.Parse(dispatcher.Handle("{\"id\":2,\"method\":\"library.inspect\",\"params\":[]}")).RootElement;
        Assert.Equal(ErrorCodes.BadRequest, malformed.GetProperty("error").GetProperty("code").GetString()); Assert.False(opened);
    }
    [Fact] public void ExportRejectsInvalidIdentityBeforeOpeningAndPreservesNativeBytes()
    {
        var opened = false; var files = Package();
        var session = new FakeTiaSession();
        var dispatcher = new RpcDispatcher(() => { opened = true; return session; }, new BridgeInfo("V20", "test"));
        var invalid = JsonDocument.Parse(dispatcher.Handle("{\"id\":1,\"method\":\"library.export\",\"params\":{\"typeGuid\":\"invalid\"}}"));
        Assert.Equal(ErrorCodes.BadRequest, invalid.RootElement.GetProperty("error").GetProperty("code").GetString()); Assert.False(opened);
        session.LibraryExport = (type, version, dir) => files;
        var response = JsonDocument.Parse(dispatcher.Handle("{\"id\":2,\"method\":\"library.export\",\"params\":{\"typeGuid\":\"b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e\",\"versionGuid\":\"51acffde-45c4-45db-a591-a5840bb011af\"}}"));
        var result = response.RootElement.GetProperty("result");
        Assert.Equal("1.0.0", result.GetProperty("metadata").GetProperty("versionNumber").GetString());
        Assert.Equal(files["type.xml"], Convert.FromBase64String(result.GetProperty("files")[0].GetProperty("contentBase64").GetString()));
        session.LibraryExport = (type, version, dir) => { var wrong = Package(); wrong["type.libinfo"] = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(wrong["type.libinfo"]).Replace(type, Guid.NewGuid().ToString("D"))); return wrong; };
        Assert.Contains("error", dispatcher.Handle("{\"id\":3,\"method\":\"library.export\",\"params\":{\"typeGuid\":\"b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e\",\"versionGuid\":\"51acffde-45c4-45db-a591-a5840bb011af\"}}"));
    }
    [Fact] public void PreviewValidatesThePackageBeforeOpeningAndRoutesThePlcScope()
    {
        var opened = false; var session = new FakeTiaSession();
        var dispatcher = new RpcDispatcher(() => { opened = true; return session; }, new BridgeInfo("V20", "test"));
        Assert.Contains(ErrorCodes.BadRequest, dispatcher.Handle("{\"id\":1,\"method\":\"library.preview\",\"params\":{\"device\":\"PLC_1\"}}")); Assert.False(opened);
        var files = Package();
        var request = JsonSerializer.Serialize(new { id = 2, method = "library.preview", @params = new { stem = "type", device = "PLC_1", files = new[] {
            new { name = "type.xml", contentBase64 = Convert.ToBase64String(files["type.xml"]) }, new { name = "type.libinfo", contentBase64 = Convert.ToBase64String(files["type.libinfo"]) } } } });
        var result = JsonDocument.Parse(dispatcher.Handle(request)).RootElement.GetProperty("result");
        Assert.Equal("PLC_1", result.GetProperty("device").GetString());
        Assert.False(result.GetProperty("nativeImportValidated").GetBoolean());
        Assert.Equal("Fx_LadEdges", result.GetProperty("package").GetProperty("typeName").GetString());
    }
    [Fact] public void ImportRefusesUnprovedLanguageBeforeNativeMutation()
    {
        var files=Package();var oldHash=Convert.ToBase64String(HexBytes(Bundle.Sha256(files["type.xml"])));
        files["type.xml"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(files["type.xml"]).Replace(">LAD<",">F_LAD<"));
        var hash=Convert.ToBase64String(HexBytes(Bundle.Sha256(files["type.xml"])));
        files["type.libinfo"]=Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(files["type.libinfo"]).Replace(oldHash,hash));
        Assert.Throws<RpcException>(()=>LibraryPackage.Check(files,"type",true));
    }
    [Fact] public void ImportRpcChecksRevisionsBeforeOpeningAndStagesUnchangedNativeBytes()
    {
        var files=Package();var package=LibraryPackage.Check(files,"type");var session=new FakeTiaSession();var opened=false;
        session.LibraryImport=(input,device,dir,stem,revision,id)=> {
            Assert.Equal(files["type.xml"],System.IO.File.ReadAllBytes(System.IO.Path.Combine(dir,"type.xml")));
            return new LibraryImportResult { TypeGuid=input.TypeGuid,VersionGuid=Guid.NewGuid().ToString("D"),State="InWork",VersionNumber="0.0.1" };
        };
        var dispatcher=new RpcDispatcher(()=> { opened=true;return session; },new BridgeInfo("V20","test"));
        string Request(string revision,string packageRevision)=>JsonSerializer.Serialize(new { id=1,method="library.import",@params=new { stem="type",device="PLC_1",
            expectedRevision=revision,expectedPackageRevision=packageRevision,operationId=Guid.NewGuid().ToString("D"),files=new[] {
                new { name="type.xml",contentBase64=Convert.ToBase64String(files["type.xml"]) },new { name="type.libinfo",contentBase64=Convert.ToBase64String(files["type.libinfo"]) } } } });
        Assert.Contains(ErrorCodes.BadRequest,dispatcher.Handle(Request("bad",package.Revision)));Assert.False(opened);
        Assert.Contains(ErrorCodes.StaleRevision,dispatcher.Handle(Request(new string('a',64),new string('b',64))));Assert.False(opened);
        var duplicate=Request(new string('a',64),package.Revision).Replace("\"expectedRevision\":", "\"expectedRevision\":\""+new string('a',64)+"\",\"expectedRevision\":");
        Assert.Contains(ErrorCodes.BadRequest,dispatcher.Handle(duplicate));Assert.False(opened);
        var result=JsonDocument.Parse(dispatcher.Handle(Request(new string('a',64),package.Revision))).RootElement.GetProperty("result");
        Assert.Equal("InWork",result.GetProperty("state").GetString());Assert.True(opened);
    }
}
