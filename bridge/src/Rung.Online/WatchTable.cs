// SPDX-License-Identifier: BUSL-1.1
using System.Xml;
using System.Xml.Linq;
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public sealed record WatchTableRow(string Key, string? Name, string? Address, string? DisplayFormat,
    string? ModifyValue, Dictionary<string, string> Comments);
public sealed record WatchTableDefinition(string Name, string? EngineeringVersion, WatchTableRow[] Rows);

public static class WatchTable
{
    public static WatchTableDefinition Parse(string xml)
    {
        if (xml.Length > 1_000_000) throw new RpcException(ErrorCodes.ResourceLimit, "Watch table XML exceeds 1 MB of characters.");
        XDocument doc;
        try {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1_000_000,
            });
            doc = XDocument.Load(reader);
        } catch (XmlException) { throw new RpcException(ErrorCodes.BadRequest, "Invalid watch table XML; DTDs are prohibited."); }
        if (doc.Descendants().Any(e => e.Name.LocalName == "SW.WatchAndForceTables.PlcForceTable"))
            throw new RpcException(ErrorCodes.ReadOnly, "Force tables cannot be monitored through this command.");
        var tables = doc.Root?.Elements().Where(e => e.Name.LocalName == "SW.WatchAndForceTables.PlcWatchTable").ToArray();
        if (doc.Root?.Name.LocalName != "Document" || tables?.Length != 1)
            throw new RpcException(ErrorCodes.BadRequest, "Expected one exported TIA watch table.");
        var table = tables[0];
        var entries = Child(table, "ObjectList")?.Elements().Where(e => e.Name.LocalName == "SW.WatchAndForceTables.PlcWatchTableEntry").ToArray() ?? [];
        if (entries.Length > 4096) throw new RpcException(ErrorCodes.ResourceLimit, "At most 4096 watch table rows.");
        return new(Value(table, "Name") ?? "", Child(doc.Root!, "Engineering")?.Attribute("version")?.Value,
            entries.Select((entry, i) => {
                var comments = new Dictionary<string, string>();
                foreach (var text in (Child(entry, "ObjectList")?.Elements() ?? []).Where(e => e.Name.LocalName == "MultilingualText" && (string?)e.Attribute("CompositionName") == "Comment"))
                    foreach (var item in (Child(text, "ObjectList")?.Elements() ?? []).Where(e => e.Name.LocalName == "MultilingualTextItem"))
                        comments[Value(item, "Culture") ?? ""] = Value(item, "Text") ?? "";
                return new WatchTableRow($"row:{i+1}", Value(entry, "Name"), Value(entry, "Address"),
                    Value(entry, "DisplayFormat"), Value(entry, "ModifyValue"), comments);
            }).ToArray());
    }

    static XElement? Child(XElement parent, string name) => parent.Elements().FirstOrDefault(e => e.Name.LocalName == name);
    static string? Value(XElement parent, string name) => Child(parent, "AttributeList") is { } attrs ? Child(attrs, name)?.Value : null;
}
