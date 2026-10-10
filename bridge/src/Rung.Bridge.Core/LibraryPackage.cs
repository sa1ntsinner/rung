// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public sealed class LibraryImportPreview
    {
        public LibraryPackage Package;
        public string Device;
        public string Revision;
        public bool NativeImportValidated; // Preview does not invoke the native importer.
    }
    public sealed class LibraryDependency { public string TypeName, VersionGuid, VersionNumber; }
    public sealed class LibraryPackage
    {
        public string TypeName, TypeGuid, SourceVersionGuid, VersionNumber, Revision;
        /// <summary>The library block: FB or FC, and its language (LAD, SCL).</summary>
        public string BlockType, Language;
        /// <summary>The released type versions this one uses, which the target project library must already hold.</summary>
        public LibraryDependency[] Dependencies = new LibraryDependency[0];
        static RpcException Invalid(string why) => new RpcException(ErrorCodes.BadRequest, "Invalid native library package: " + why);
        public static LibraryPackage Check(IReadOnlyDictionary<string, byte[]> files, string stem, bool forImport = false)
        {
            // ponytail: proven released dependency-free V20 XML/libinfo pair; add formats/dependencies only with native round-trip evidence.
            if (stem == null || !Regex.IsMatch(stem, "^[A-Za-z0-9_-]{1,64}$") || files == null || files.Count != 2
                || !files.ContainsKey(stem + ".xml") || !files.ContainsKey(stem + ".libinfo")
                || files.Any(f => f.Value == null || f.Value.Length == 0 || f.Value.Length > 4 * 1024 * 1024)
                || files.Sum(f => (long)f.Value.Length) > 4 * 1024 * 1024) throw Invalid("unsupported names, file count or size");
            try
            {
                var metadata = files[stem + ".libinfo"];
                if (metadata.Length > 1024 * 1024) throw Invalid("metadata too large");
                var text = new UTF8Encoding(false, true).GetString(metadata).TrimStart('\uFEFF');
                using (var doc = JsonDocument.Parse(text))
                {
                    var root = doc.RootElement;
                    void Fields(JsonElement obj, params string[] allowed)
                    {
                        if (obj.ValueKind != JsonValueKind.Object) throw Invalid("metadata object missing");
                        var seen = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var p in obj.EnumerateObject()) if (!allowed.Contains(p.Name) || !seen.Add(p.Name)) throw Invalid("unknown or duplicate metadata field");
                        if (seen.Count != allowed.Length) throw Invalid("metadata field missing");
                    }
                    void Comments(JsonElement obj)
                    {
                        if (obj.ValueKind != JsonValueKind.Object || obj.EnumerateObject().Count() > 256) throw Invalid("invalid multilingual comments");
                        var names = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var p in obj.EnumerateObject()) if (!names.Add(p.Name) || p.Name.Length > 128 || p.Value.ValueKind != JsonValueKind.String) throw Invalid("invalid multilingual comment");
                    }
                    string GuidText(JsonElement obj) { var value = obj.GetProperty("Guid").GetString(); if (!Guid.TryParseExact(value, "D", out var guid) || guid == Guid.Empty) throw Invalid("invalid GUID"); return guid.ToString("D"); }
                    Fields(root, "DocumentHash", "LibraryMetaFileHash", "LibraryType", "LibraryVersion");
                    if (Convert.FromBase64String(root.GetProperty("LibraryMetaFileHash").GetString()).Length != 32) throw Invalid("invalid native metadata hash");
                    var hashes = root.GetProperty("DocumentHash");
                    if (hashes.ValueKind != JsonValueKind.Array || hashes.GetArrayLength() != 1) throw Invalid("unsupported document set");
                    var hash = hashes[0]; Fields(hash, "FileName", "Hash");
                    if (hash.GetProperty("FileName").GetString() != stem + ".xml") throw Invalid("document identity differs");
                    var declared = Convert.FromBase64String(hash.GetProperty("Hash").GetString());
                    var actual = Bundle.Sha256(files[stem + ".xml"]);
                    if (declared.Length != 32 || string.Concat(declared.Select(b => b.ToString("x2"))) != actual) throw Invalid("raw document hash differs");
                    var type = root.GetProperty("LibraryType"); Fields(type, "Guid", "DoNotUse", "Comment");
                    if (type.GetProperty("DoNotUse").ValueKind != JsonValueKind.False) throw Invalid("type is marked do-not-use");
                    Comments(type.GetProperty("Comment"));
                    var version = root.GetProperty("LibraryVersion");
                    Fields(version, "Guid", "VersionNumber", "Author", "IsDefault", "InWork", "Comment", "MinimumTargetDeviceVersion", "DependsOn");
                    if (version.GetProperty("InWork").ValueKind != JsonValueKind.False || version.GetProperty("IsDefault").ValueKind != JsonValueKind.True)
                        throw Invalid("only released default versions are supported");
                    var number = version.GetProperty("VersionNumber").GetString();
                    if (!Version.TryParse(number, out var parsed) || parsed.Build < 0 || parsed.Revision != -1 || parsed.ToString() != number) throw Invalid("unsupported version number");
                    if (version.GetProperty("Author").ValueKind != JsonValueKind.String || version.GetProperty("MinimumTargetDeviceVersion").GetString() != "") throw Invalid("unsupported version attributes");
                    Comments(version.GetProperty("Comment"));
                    var dependencies = version.GetProperty("DependsOn");
                    if (dependencies.ValueKind != JsonValueKind.Array || dependencies.GetArrayLength() > 16) throw Invalid("unsupported dependency list");
                    var uses = new List<LibraryDependency>();
                    foreach (var dependency in dependencies.EnumerateArray())
                    {
                        // seen live: {TypeName, Guid (the dependency's released version), VersionNumber, IsDefault}
                        Fields(dependency, "TypeName", "Guid", "VersionNumber", "IsDefault");
                        var name = dependency.GetProperty("TypeName").GetString(); var at = dependency.GetProperty("VersionNumber").GetString();
                        if (string.IsNullOrEmpty(name) || name.Length > 128 || name.Any(char.IsControl) || dependency.GetProperty("IsDefault").ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                            || !Version.TryParse(at, out var v) || v.Build < 0 || v.Revision != -1 || v.ToString() != at) throw Invalid("invalid dependency");
                        var use = new LibraryDependency { TypeName = name, VersionGuid = GuidText(dependency), VersionNumber = at };
                        if (uses.Any(u => u.VersionGuid == use.VersionGuid || u.TypeName == use.TypeName)) throw Invalid("duplicate dependency");
                        uses.Add(use);
                    }
                    using (var stream = new MemoryStream(files[stem + ".xml"]))
                    using (var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4 * 1024 * 1024 }))
                    {
                        var xml = XDocument.Load(reader); var blocks = xml.Root?.Elements().Where(e => e.Name == "SW.Blocks.FB" || e.Name == "SW.Blocks.FC" || e.Name == "SW.Types.PlcStruct").ToArray();
                        var engineering = xml.Root?.Elements("Engineering").ToArray();
                        if (xml.Root?.Name != "Document" || blocks == null || blocks.Length != 1 || engineering == null || engineering.Length != 1 || (string)engineering[0].Attribute("version") != "V20") throw Invalid("unsupported native XML domain/version");
                        if (xml.Root.Elements().Any(e => e != blocks[0] && e != engineering[0] && e.Name != "DocumentInfo") || xml.Root.Elements("DocumentInfo").Count() > 1)
                            throw Invalid("unexpected native object");
                        var names = blocks[0].Elements("AttributeList").Elements("Name").ToArray();
                        if (names.Length != 1 || string.IsNullOrEmpty(names[0].Value) || names[0].Value.Length > 128) throw Invalid("block name missing or ambiguous");
                        if (forImport)
                        {
                            var attributes = blocks[0].Elements("AttributeList").ToArray();
                            // seen live: TIA creates LAD and SCL FB/FC types from these documents
                            if (attributes.Length != 1
                                || blocks[0].Name != "SW.Types.PlcStruct" && (attributes[0].Elements("ProgrammingLanguage").Count() != 1 || !new[] { "LAD", "SCL" }.Contains(attributes[0].Element("ProgrammingLanguage")?.Value))
                                || attributes[0].Elements("Namespace").Any(n => !string.IsNullOrEmpty(n.Value))
                                || attributes[0].Elements("IsKnowHowProtected").Any(n => n.Value != "false"))
                                throw Invalid("native import is validated only for unprotected LAD/SCL FBs and FCs without a namespace");
                        }
                        return new LibraryPackage { TypeName = names[0].Value, BlockType = blocks[0].Name == "SW.Types.PlcStruct" ? "UDT" : blocks[0].Name.LocalName.Substring("SW.Blocks.".Length), Dependencies = uses.ToArray(), Language = blocks[0].Element("AttributeList")?.Element("ProgrammingLanguage")?.Value, TypeGuid = GuidText(type), SourceVersionGuid = GuidText(version), VersionNumber = number,
                            Revision = Bundle.Hash(new[] { new ExportFile { Role = "xml", Sha256 = actual }, new ExportFile { Role = "libinfo", Sha256 = Bundle.Sha256(metadata) } }) };
                    }
                }
            }
            catch (RpcException) { throw; }
            catch (Exception e) when (e is JsonException || e is XmlException || e is InvalidOperationException || e is FormatException || e is KeyNotFoundException || e is ArgumentException)
            { throw Invalid("malformed metadata or XML"); }
        }
    }
}
