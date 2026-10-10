// SPDX-License-Identifier: BUSL-1.1
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public sealed record NativeBody(string CompilationUnit, string Text);
public sealed record NativeScalar(string Name, uint BitOffset, uint Bits, string Type);
/// <summary>A local constant the compiled code uses, with the value it was compiled with.</summary>
public sealed record NativeConstant(string Name, string Type, string Value);
/// <summary>A user FC the captured code calls, as the PLC holds it.</summary>
public sealed record NativeFunctionSource(string Name, NativeBody[] Bodies, NativeConstant[] Constants);
public sealed record NativeRootCall(string Instance, uint Database, uint FunctionBlock, uint Sac, string CompilationUnit, string Element);

/// <summary>Renders explicit SCL syntax only; unsupported native nodes are refused.</summary>
public static class NativeSource
{
    static readonly Dictionary<string, string> Tokens = new() {
        ["OpAs"] = ":=", ["OpPl"] = "+", ["OpMi"] = "-", ["OpMu"] = "*", ["OpDi"] = "/",
        ["OpU"] = "<>", ["OpG"] = ">", ["OpL"] = "<", ["OpE"] = "=", ["OpGE"] = ">=", ["OpLE"] = "<=",
        ["OpAND"] = "AND", ["OpOR"] = "OR", ["OpNOT"] = "NOT", ["OpMOD"] = "MOD", ["OpXOR"] = "XOR",
        ["BracO"] = "(", ["BracC"] = ")", ["BoxO"] = "[", ["BoxC"] = "]", ["FiSt"] = ";", ["Comma"] = ",", ["Colon"] = ":",
        ["Dot"] = ".", ["LDots"] = "..", ["KwENDC"] = "END_CASE", ["KwENDIF"] = "END_IF", ["KwENDFOR"] = "END_FOR",
        ["KwBY"] = "BY", ["KwDO"] = "DO", ["KwELSE"] = "ELSE", ["KwOF"] = "OF", ["KwTHEN"] = "THEN", ["KwTO"] = "TO",
    };
    static readonly HashSet<string> Containers = ["RootStatements", "Statement", "Statements", "Expression", "FctCa", "InstCa", "Fold", "Param", "CaseElem", "CaseRange", "CaseSRange"];

    static XDocument Parse(string xml)
    {
        if (xml.Length > 1_048_576) throw new RpcException(ErrorCodes.ResourceLimit, "Native body exceeds 1 MB.");
        using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1_048_576,
        });
        return XDocument.Load(reader);
    }

    public static NativeRootCall[] RootCallSites(string debugXml, string[] bodies, string[] references, string instance)
    {
        if (bodies.Length is 0 or > 256 || bodies.Sum(b => (long)b.Length) > 1_048_576 || string.IsNullOrWhiteSpace(instance) || instance.Length > 128)
            throw new NotSupportedException("Native caller bodies exceed limits.");
        var calls = bodies.SelectMany(text => {
            var document = Parse(text);
            return document.Descendants().Where(e => e.Name.LocalName == "Sub" && (string?)e.Attribute("ODN") == "\"" + instance + "\"")
                .Select(call => (Text: text, Cu: (string?)document.Root?.Attribute("RefID"), Uid: (string?)call.Attribute("UId")));
        }).ToArray();
        var selected = calls.Single();
        if (string.IsNullOrEmpty(selected.Cu) || string.IsNullOrEmpty(selected.Uid)) throw new NotSupportedException("Incomplete native call location.");
        var operands = Parse(debugXml).Descendants().Where(e => e.Name.LocalName == "Operand"
            && (string?)e.Attribute("cuId") == selected.Cu && (string?)e.Attribute("elementId") == selected.Uid).ToArray();
        if (operands.Length is 0 or > 256) throw new NotSupportedException("Missing or excessive caller SACs.");
        return operands.Select(operand => RootCall(debugXml, selected.Text, references,
            (uint?)operand.Attribute("sac") ?? throw new NotSupportedException("Missing caller SAC."))).ToArray();
    }

    /// <summary>
    /// Where a caller FB calls its multi-instance #member (InstCa/Sub SI="FB"): the call sites' SACs, as the caller frames
    /// of a sample name them, and the FB that instance is of, from the cross-reference.
    /// </summary>
    public static (uint Callee, uint[] Sacs) MemberCallSites(string debugXml, string[] bodies, string[] references, string member)
    {
        if (bodies.Length is 0 or > 256 || bodies.Sum(b => (long)b.Length) > 1_048_576 || references.Length > 256 || string.IsNullOrWhiteSpace(member) || member.Length > 128)
            throw new NotSupportedException("Native caller bodies exceed limits.");
        var calls = bodies.SelectMany(text => {
            var document = Parse(text);
            var cu = (string?)document.Root?.Attribute("RefID");
            return document.Descendants().Where(e => e.Name.LocalName == "Sub" && (string?)e.Attribute("SI") == "FB" && (string?)e.Attribute("ODN") == "#" + member
                && e.Parent?.Name.LocalName == "InstCa").Select(call => (Cu: cu, Uid: (string?)call.Attribute("UId")));
        }).ToArray();
        if (calls.Length == 0 || calls.Any(c => string.IsNullOrEmpty(c.Cu) || string.IsNullOrEmpty(c.Uid))) throw new NotSupportedException($"#{member} is not called as a multi-instance in its caller.");
        var sacs = Parse(debugXml).Descendants().Where(e => e.Name.LocalName == "Operand" && calls.Any(c => (string?)e.Attribute("cuId") == c.Cu && (string?)e.Attribute("elementId") == c.Uid))
            .Select(e => (uint?)e.Attribute("sac") ?? throw new NotSupportedException("Missing caller SAC.")).Distinct().OrderBy(s => s).ToArray();
        var uids = calls.Select(c => c.Uid).ToHashSet();
        var callees = references.SelectMany(r => Parse(r).Descendants().Where(e => e.Name.LocalName == "Ident"
                && e.Descendants().Any(x => x.Name.LocalName == "XRefItem" && (string?)x.Attribute("Usage") == "Call" && uids.Contains((string?)x.Attribute("UId")))))
            .SelectMany(i => i.Descendants().Where(e => e.Name.LocalName == "FBBlock").Select(e => (uint?)e.Attribute("BlockNumber") ?? 0)).Distinct().ToArray();
        if (sacs.Length is 0 or > 256 || callees.Length != 1 || callees[0] is 0 or > 65535) throw new NotSupportedException($"The call of #{member} has no unique call site or FB.");
        return (callees[0], sacs);
    }

    public static NativeRootCall RootCall(string debugXml, string bodyXml, string[] references, uint sac)
    {
        if (references.Length is 0 or > 256 || references.Sum(r => (long)r.Length) > 1_048_576)
            throw new NotSupportedException("Native call references exceed limits.");
        static string Id(XElement node, string attribute) => (string?)node.Attribute(attribute) is { Length: > 0 } value
            ? value : throw new NotSupportedException("Missing native call identifier.");
        var body = Parse(bodyXml);
        var cu = (string?)body.Root?.Attribute("RefID") ?? throw new NotSupportedException("Missing caller compilation unit.");
        var operand = Parse(debugXml).Descendants().Single(e => e.Name.LocalName == "Operand" && (uint?)e.Attribute("sac") == sac && (string?)e.Attribute("cuId") == cu);
        var uid = (string?)operand.Attribute("elementId") ?? throw new NotSupportedException("Missing caller element.");
        var call = body.Descendants().Single(e => (string?)e.Attribute("UId") == uid);
        var name = (string?)call.Attribute("ODN") ?? "";
        // ponytail: root instance DB calls only; nested routes require validated stack traversal.
        if (call.Name.LocalName != "Sub" || call.Parent?.Name.LocalName != "InstCa" || (string?)call.Attribute("SI") != "DB"
            || !System.Text.RegularExpressions.Regex.IsMatch(name, "^\"[^\"\\r\\n]+\"$"))
            throw new NotSupportedException("Unsupported native instance call.");
        var symbolId = Id(call, "SyId");
        var symbol = body.Descendants().Single(e => e.Name.LocalName == "DBBlock" && (string?)e.Attribute("SymID") == symbolId);
        var typeId = Id(symbol, "TypeSymID");
        var type = body.Descendants().Single(e => e.Name.LocalName == "FBBlock" && (string?)e.Attribute("SymID") == typeId);
        var identifiers = references.SelectMany(r => Parse(r).Descendants().Where(e => e.Name.LocalName == "Ident")).ToArray();
        XElement Reference(XElement binding, string usage) => identifiers.Single(e => (string?)e.Attribute("Scope") == "Global"
            && (string?)e.Attribute("RefId") == Id(binding, "RefId")
            && e.Descendants().Any(x => x.Name.LocalName == "XRefItem" && (string?)x.Attribute("UId") == uid
                && (string?)x.Attribute("NetId") == cu && (string?)x.Attribute("Usage") == usage));
        var database = Reference(symbol, "InstanceDB"); var function = Reference(type, "Call");
        var dbAccess = database.Descendants().Single(e => e.Name.LocalName == "AufDBBlock");
        var fbAccess = function.Descendants().Single(e => e.Name.LocalName == "FBBlock");
        var dbNumber = (uint?)dbAccess.Attribute("BlockNumber") ?? 0;
        var fbNumber = (uint?)fbAccess.Attribute("BlockNumber") ?? 0;
        if ((string?)database.Attribute("Name") != name[1..^1] || (string?)dbAccess.Attribute("BlockType") != "DB"
            || (string?)fbAccess.Attribute("BlockType") != "FB" || dbNumber is 0 or > 65535 || fbNumber is 0 or > 65535
            || (string?)fbAccess.Attribute("TypeName") is not { Length: > 0 } typeName || (string?)dbAccess.Attribute("TypeName") != typeName
            || (string?)fbAccess.Attribute("RId") is not { Length: > 0 } rid || (string?)dbAccess.Attribute("RId") != rid
            || !function.Descendants().Any(e => e.Name.LocalName == "XRefItem" && (string?)e.Attribute("UId") == uid
                && (string?)e.Attribute("NetId") == cu && (string?)e.Attribute("Usage") == "Call" && (string?)e.Attribute("Name") == name))
            throw new NotSupportedException("Native call references disagree.");
        return new(name[1..^1], dbNumber, fbNumber, sac, cu, uid);
    }

    public static NativeScalar[] Scalars(string debugXml, string bodyXml) => Scalars(debugXml, bodyXml, out _);

    /// <param name="pointer">the native pointer every instance member is addressed through.</param>
    public static NativeScalar[] Scalars(string debugXml, string bodyXml, out uint pointer)
    {
        var rendered = Render(bodyXml);
        var nodes = Parse(bodyXml).Descendants().Where(e => e.Attribute("UId") != null).ToDictionary(e => e.Attribute("UId")!.Value);
        var debug = Parse(debugXml);
        var values = debug.Descendants().Where(e => e.Name.LocalName == "DebugValue").ToDictionary(e => (string?)e.Attribute("id") ?? throw new NotSupportedException("Missing debug value ID."));
        var bindings = new Dictionary<string, NativeScalar>();
        uint? instancePointer = null;
        foreach (var element in debug.Descendants().Where(e => e.Name.LocalName == "LanguageElement" && (string?)e.Attribute("cuId") == rendered.CompilationUnit)) {
            if (!nodes.TryGetValue((string?)element.Attribute("elementId") ?? "", out var node)) throw new NotSupportedException("Unmapped native language element.");
            // a local (#Count), a member monitored alone (a of #s.a: its path is the parent's text) or a whole element (#arr[1])
            var odn = (string?)node.Attribute("ODN");
            var name = node.Name.LocalName == "SymVa" && odn?.StartsWith('#') == true ? odn
                : node.Name.LocalName == "SymVa" && (string?)node.Parent?.Attribute("SI") == "ExprDot" && node.ElementsBeforeSelf().LastOrDefault()?.Name.LocalName == "Dot" ? Text(node.Parent!)
                : node.Name.LocalName == "Expression" ? Text(node) : null;
            if (name == null) continue;
            var path = System.Text.RegularExpressions.Regex.IsMatch(name, @"^#[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*|\[-?\d+\])*$");
            foreach (var monitoring in element.Elements().Where(e => e.Name.LocalName == "MonitoringElement")) {
                var value = values[(string?)monitoring.Attribute("debugValueRef") ?? ""];
                var address = value.Descendants().SingleOrDefault(e => e.Name.LocalName == "Indirect");
                // Compiler temporary results do not describe persistent instance memory.
                if (address == null && value.Descendants().Any(e => e.Name.LocalName == "Native" && (string?)e.Attribute("scope") == "NativeLocal")) continue;
                // an expression is no state of its own (a sum carries its target's address); a computed element (#arr[#i])
                // stays uncaptured, and the replay refuses if the cycle reads it
                // a value TIA Portal computes for display (no address in the instance) is no state either: a member that never
                // shows with an address stays uncaptured the same way
                if (!path || address == null) continue;
                // pointerNumber names the native pointer the instance is addressed through (4 on S7-1500 V20), not a block number
                if ((string?)address.Attribute("typeSafe") != "true" || (string?)address.Attribute("granted") != "true"
                    || (string?)address.Attribute("pointerScope") != "NativeBlock" || (uint?)address.Attribute("pointerNumber") is not { } addressPointer
                    || (instancePointer ??= addressPointer) != addressPointer)
                    throw new NotSupportedException($"Native address scope of {name} is unsupported ({(string?)address.Attribute("pointerScope")}, typeSafe {(string?)address.Attribute("typeSafe")}, granted {(string?)address.Attribute("granted")}, pointer {(string?)address.Attribute("pointerNumber")}).");
                var binding = new NativeScalar(name[1..].ToUpperInvariant(), (uint?)address.Attribute("bitOffset") ?? throw new NotSupportedException("Missing native offset."),
                    (uint?)value.Attribute("bitSize") ?? throw new NotSupportedException("Missing native width."), (string?)monitoring.Attribute("type") ?? throw new NotSupportedException("Missing native type."));
                if (bindings.TryGetValue(binding.Name, out var previous) && previous != binding) throw new NotSupportedException("Ambiguous native symbol address.");
                if (bindings.Values.Any(b => b.Name != binding.Name && b.BitOffset == binding.BitOffset)) throw new NotSupportedException("Aliased native symbol address.");
                bindings[binding.Name] = binding;
            }
        }
        if (bindings.Count == 0) throw new NotSupportedException("No supported native scalar state.");
        pointer = instancePointer!.Value;
        return bindings.Values.OrderBy(b => b.BitOffset).ToArray();
    }

    /// <summary>The numbers of the FCs a block's code calls, from its cross references.</summary>
    public static uint[] CalledFunctions(string[] references)
    {
        if (references.Length > 256 || references.Sum(r => (long)r.Length) > 1_048_576) throw new NotSupportedException("Native call references exceed limits.");
        return references.SelectMany(r => Parse(r).Descendants().Where(e => e.Name.LocalName == "Ident"
                && e.Descendants().Any(x => x.Name.LocalName == "XRefItem" && (string?)x.Attribute("Usage") == "Call")))
            .SelectMany(i => i.Descendants().Where(e => e.Name.LocalName == "FCBlock").Select(e => (uint?)e.Attribute("BlockNumber") ?? throw new NotSupportedException("Missing FC number.")))
            .Distinct().OrderBy(n => n).ToArray();
    }

    /// <summary>The local constants the body uses (#LIMIT), each with the immediate value the debug info shows for it.</summary>
    public static NativeConstant[] Constants(string debugXml, string bodyXml)
    {
        var body = Parse(bodyXml);
        var cu = (string?)body.Root?.Attribute("RefID");
        var nodes = body.Descendants().Where(e => e.Attribute("UId") != null).ToDictionary(e => e.Attribute("UId")!.Value);
        var debug = Parse(debugXml);
        var values = debug.Descendants().Where(e => e.Name.LocalName == "DebugValue").ToDictionary(e => (string?)e.Attribute("id") ?? "");
        var found = new Dictionary<string, NativeConstant>(StringComparer.Ordinal);
        foreach (var element in debug.Descendants().Where(e => e.Name.LocalName == "LanguageElement" && (string?)e.Attribute("cuId") == cu))
        {
            if (!nodes.TryGetValue((string?)element.Attribute("elementId") ?? "", out var node) || node.Name.LocalName != "SymVa"
                || ((string?)node.Attribute("SI"))?.StartsWith("Const", StringComparison.Ordinal) != true || (string?)node.Attribute("ODN") is not { } odn || !odn.StartsWith('#')) continue;
            foreach (var monitoring in element.Elements().Where(e => e.Name.LocalName == "MonitoringElement"))
            {
                if (!values.TryGetValue((string?)monitoring.Attribute("debugValueRef") ?? "", out var value)) continue;
                var immediate = value.Descendants().FirstOrDefault(e => e.Name.LocalName == "Immediate");
                if ((string?)immediate?.Attribute("value") is not { } v || (string?)monitoring.Attribute("type") is not { } type) continue;
                var constant = new NativeConstant(odn[1..].ToUpperInvariant(), type, v);
                if (found.TryGetValue(constant.Name, out var seen) && seen != constant) throw new NotSupportedException("Native constant " + odn + " shows two values.");
                found[constant.Name] = constant;
            }
        }
        return found.Values.OrderBy(c => c.Name, StringComparer.Ordinal).ToArray();
    }

    /// <summary>The source text of one node: a path (#s.a, #arr[1]) reads as written.</summary>
    static string Text(XElement node)
    {
        var text = new StringBuilder();
        foreach (var e in node.DescendantsAndSelf())
        {
            var n = e.Name.LocalName;
            if (n is "SymVa" or "Sub" or "SymPa") text.Append((string?)e.Attribute("ODN"));
            else if (e.Attribute("TE") is { } token && n != "LC") text.Append(token.Value);
            else if (Tokens.TryGetValue(n, out var value)) text.Append(value);
        }
        return text.ToString();
    }

    public static NativeBody Render(string xml)
    {
        var doc = Parse(xml);
        var network = doc.Root;
        if (network?.Name.LocalName != "Network" || (string?)network.Attribute("Lang") != "SCL"
            || string.IsNullOrEmpty((string?)network.Attribute("RefID"))) throw new NotSupportedException("Native SCL network required.");
        var root = network.Descendants().Single(e => e.Name.LocalName == "RootStatements");
        var text = new StringBuilder(); var ids = new HashSet<string>(); int nodes = 0;
        void Visit(XElement node, int depth)
        {
            if (++nodes > 100_000 || depth > 64) throw new RpcException(ErrorCodes.ResourceLimit, "Native syntax limit exceeded.");
            if (node.Attribute("UId") is { } id && !ids.Add(id.Value)) throw new NotSupportedException("Duplicate native UID.");
            var name = node.Name.LocalName;
            if (name == "NL") text.Append('\n');
            else if (name == "BL") {
                var spaces = node.Attribute("NumBLs") is { } count ? int.Parse(count.Value) : 1;
                if (spaces < 0 || spaces > 4096) throw new NotSupportedException("Native whitespace limit exceeded.");
                text.Append(' ', spaces);
            } else if (name == "LC") text.Append("//").Append((string?)node.Attribute("TE") ?? "");
            else if (name is "SymVa" or "Sub" or "SymPa") text.Append((string?)node.Attribute("ODN") ?? throw new NotSupportedException("Missing native symbol spelling."));
            else if (node.Attribute("TE") is { } token) text.Append(token.Value);
            else if (Tokens.TryGetValue(name, out var value)) text.Append(value);
            else if (!Containers.Contains(name) || !node.HasElements) throw new NotSupportedException("Unsupported native syntax: " + name);
            if (text.Length > 1_048_576) throw new RpcException(ErrorCodes.ResourceLimit, "Rendered native body exceeds 1 MB.");
            foreach (var child in node.Elements()) Visit(child, depth + 1);
        }
        Visit(root, 0);
        return new(network.Attribute("RefID")!.Value, text.ToString());
    }
}
