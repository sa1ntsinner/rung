// SPDX-License-Identifier: BUSL-1.1
// A PLC tag table as text (plc/<PLC>/tags/<Table>.tags.st): an IEC global variable list with one tag per line,
// converted from and to the SimaticML TIA Portal exports and imports. A table the text cannot hold without loss
// stays SimaticML: FromXml says why.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Rung.Bridge.Core
{
    public sealed class TagTableTextException : Exception
    {
        /// <summary>The line of the text the error is on.</summary>
        public readonly int Line;
        public TagTableTextException(string message, int line = 0) : base(message) { Line = line; }
    }

    public sealed class TagTableTextResult
    {
        /// <summary>The text, or null when the table stays SimaticML (Reason says why).</summary>
        public string Text;
        /// <summary>The language of the comments ("en-US"), null when no tag has one.</summary>
        public string Culture;
        public string Reason;
    }

    public static class TagTableText
    {
        static readonly string[] External = { "ExternalAccessible", "ExternalVisible", "ExternalWritable" };
        static readonly HashSet<string> TagAttributes = new HashSet<string>(new[] { "Name", "DataTypeName", "LogicalAddress" }.Concat(External), StringComparer.Ordinal);
        static readonly HashSet<string> ConstantAttributes = new HashSet<string>(new[] { "Name", "DataTypeName", "Value" }, StringComparer.Ordinal);
        static readonly Regex Identifier = new Regex(@"^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);
        static readonly Regex Word = new Regex(@"^[\p{L}_][\p{L}\p{Nd}_]*$", RegexOptions.CultureInvariant);
        static readonly Regex Address = new Regex(@"^%[A-Za-z]{1,3}\d+(\.\d+)?$", RegexOptions.CultureInvariant);
        // names an ST reader takes for a keyword in a declaration list (a section's end or modifier) go in quotes
        static readonly HashSet<string> Reserved = new HashSet<string>(new[] {
            "VAR_GLOBAL", "END_VAR", "VAR", "CONSTANT", "AT", "TRUE", "FALSE", "RETAIN", "NON_RETAIN", "PERSISTENT", "DB_SPECIFIC", "BEGIN",
            "END_STRUCT", "END_TYPE", "END_FUNCTION", "END_FUNCTION_BLOCK", "END_ORGANIZATION_BLOCK", "END_DATA_BLOCK", "END_PROGRAM" }, StringComparer.OrdinalIgnoreCase);

        const string Tags = "SW.Tags.PlcTag";
        const string Constants = "SW.Tags.PlcUserConstant";

        static TagTableTextResult Lossy(string reason) => new TagTableTextResult { Reason = reason };

        public static TagTableTextResult FromXml(string xml)
        {
            XDocument doc;
            try { doc = XDocument.Parse(xml); }
            catch (XmlException e) { return Lossy("the export is not readable XML (" + e.Message + ")"); }
            var table = doc.Root?.Element("SW.Tags.PlcTagTable");
            if (table == null) return Lossy("the export holds no tag table");
            var tableAttributes = table.Element("AttributeList")?.Elements().ToList() ?? new List<XElement>();
            var other = tableAttributes.FirstOrDefault(e => e.Name.LocalName != "Name");
            if (other != null) return Lossy("the table has the setting " + other.Name.LocalName);
            var name = table.Element("AttributeList")?.Element("Name")?.Value ?? "";
            if (table.Elements().Any(e => e.Name.LocalName != "AttributeList" && e.Name.LocalName != "ObjectList")) return Lossy("the table holds more than tags and constants");

            string culture = null;
            var tagLines = new List<(Entry Entry, string Line)>();
            var constantLines = new List<(Entry Entry, string Line)>();
            foreach (var o in table.Element("ObjectList")?.Elements() ?? Enumerable.Empty<XElement>())
            {
                var kind = o.Name.LocalName;
                if (kind != Tags && kind != Constants) return Lossy("the table holds " + kind);
                var part = o.Elements().FirstOrDefault(e => e.Name.LocalName != "AttributeList" && e.Name.LocalName != "ObjectList");
                if (part != null) return Lossy((o.Element("AttributeList")?.Element("Name")?.Value ?? "an entry") + " holds " + part.Name.LocalName);
                var list = o.Element("AttributeList")?.Elements().ToList() ?? new List<XElement>();
                var allowed = kind == Tags ? TagAttributes : ConstantAttributes;
                var attrs = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var a in list)
                {
                    var key = a.Name.LocalName;
                    if (!allowed.Contains(key) || a.HasElements || a.HasAttributes || attrs.ContainsKey(key)) return Lossy("a " + (kind == Tags ? "tag" : "constant") + " has the setting " + key);
                    attrs[key] = a.Value;
                }
                if (!attrs.TryGetValue("Name", out var tagName) || tagName.Length == 0) return Lossy("an entry has no name");
                if (tagName.IndexOf('"') >= 0 || tagName.Any(char.IsControl)) return Lossy("the name " + tagName + " has a quote or a control character");
                var type = attrs.TryGetValue("DataTypeName", out var t) ? t : "";
                if (type.Length == 0 || type.IndexOf(';') >= 0 || type.Contains("//") || type.Any(char.IsControl)) return Lossy(tagName + " has the data type \"" + type + "\"");

                // comments: MultilingualText "Comment" with one item per project language
                string comment = null;
                foreach (var child in o.Element("ObjectList")?.Elements() ?? Enumerable.Empty<XElement>())
                {
                    if (child.Name.LocalName != "MultilingualText" || (string)child.Attribute("CompositionName") != "Comment") return Lossy(tagName + " holds " + child.Name.LocalName);
                    if (child.Elements().Any(e => e.Name.LocalName != "ObjectList")) return Lossy(tagName + " has a comment the text form cannot hold");
                    foreach (var item in child.Element("ObjectList")?.Elements() ?? Enumerable.Empty<XElement>())
                    {
                        if (item.Name.LocalName != "MultilingualTextItem" || item.Elements().Any(e => e.Name.LocalName != "AttributeList")) return Lossy(tagName + " has a comment the text form cannot hold");
                        var itemAttrs = item.Element("AttributeList")?.Elements().ToList() ?? new List<XElement>();
                        if (itemAttrs.Any(a => a.Name.LocalName != "Culture" && a.Name.LocalName != "Text")) return Lossy(tagName + " has a comment the text form cannot hold");
                        // spaces at the ends of a comment are not kept (they carry nothing and are common in real projects)
                        var text = (itemAttrs.FirstOrDefault(a => a.Name.LocalName == "Text")?.Value ?? "").Trim();
                        if (text.Length == 0) continue;
                        var lang = itemAttrs.FirstOrDefault(a => a.Name.LocalName == "Culture")?.Value ?? "";
                        if (culture != null && culture != lang) return Lossy("its comments are in more than one language (" + culture + ", " + lang + ")");
                        culture = lang;
                        if (text.IndexOf('\n') >= 0 || text.IndexOf('\r') >= 0) return Lossy("the comment of " + tagName + " has several lines");
                        comment = text;
                    }
                }
                var tail = comment == null ? "" : "  // " + comment;
                var entry = new Entry { Name = tagName, Type = type, Comment = comment, Constant = kind == Constants };
                if (kind == Tags)
                {
                    if (!attrs.TryGetValue("LogicalAddress", out var address) || !Address.IsMatch(address)) return Lossy(tagName + " has the address \"" + (address ?? "") + "\"");
                    var flags = External.Where(attrs.ContainsKey).Select(k => k + " := '" + attrs[k] + "'").ToList();
                    if (External.Any(k => attrs.ContainsKey(k) && attrs[k] != "true" && attrs[k] != "false")) return Lossy(tagName + " has an HMI setting the text form cannot hold");
                    foreach (var k in External.Where(attrs.ContainsKey)) entry.Flags[k] = attrs[k];
                    entry.Address = address;
                    tagLines.Add((entry, "    " + NameText(tagName) + (flags.Count > 0 ? " {" + string.Join("; ", flags) + "}" : "") + " AT " + address + " : " + type + ";" + tail));
                }
                else
                {
                    var value = attrs.TryGetValue("Value", out var v) ? v : "";
                    if (value.Length == 0 || value.Any(char.IsControl)) return Lossy("the constant " + tagName + " has the value \"" + value + "\"");
                    entry.Value = value;
                    constantLines.Add((entry, "    " + NameText(tagName) + " : " + type + " := " + value + ";" + tail));
                }
            }

            var sb = new StringBuilder();
            var lineCount = 0;
            void Add(string line, Entry e = null)
            {
                sb.Append(line).Append('\n');
                if (e != null) e.Line = lineCount + 1;
                lineCount++;
            }
            Add("// PLC tag table " + name + " in TIA Portal; rung sync writes changes to TIA Portal.");
            Add("// A tag: Name AT %address : Type;  // comment        A constant: Name : Type := value;");
            Add("// {ExternalAccessible := 'false'} hides a tag from HMI and OPC UA; ExternalVisible and ExternalWritable likewise.");
            Add("VAR_GLOBAL");
            foreach (var (e, l) in tagLines) Add(l, e);
            Add("END_VAR");
            if (constantLines.Count > 0)
            {
                Add("");
                Add("VAR_GLOBAL CONSTANT");
                foreach (var (e, l) in constantLines) Add(l, e);
                Add("END_VAR");
            }
            // the text goes back to TIA Portal on the next import: what it reads back must be what TIA Portal holds
            // (a value or type with a quote or // of its own would come back changed, or not at all)
            var output = sb.ToString();
            var written = tagLines.Concat(constantLines).Select(x => x.Entry).ToList();
            List<Entry> back;
            try { back = Parse(output); }
            catch (TagTableTextException e) { return Lossy("the text form does not read " + (written.FirstOrDefault(x => x.Line == e.Line)?.Name ?? "the table") + " back the same (" + e.Message + ")"); }
            var changed = written.Where((x, i) => i >= back.Count || !Same(x, back[i])).FirstOrDefault();
            if (changed != null || back.Count != written.Count) return Lossy("the text form does not read " + (changed?.Name ?? "the table") + " back the same");
            return new TagTableTextResult { Text = output, Culture = culture };
        }

        static bool Same(Entry a, Entry b) =>
            a.Name == b.Name && a.Type == b.Type && a.Address == b.Address && a.Value == b.Value && a.Comment == b.Comment && a.Constant == b.Constant &&
            a.Flags.Count == b.Flags.Count && a.Flags.All(f => b.Flags.TryGetValue(f.Key, out var v) && v == f.Value);

        static string NameText(string name) => Identifier.IsMatch(name) && !Reserved.Contains(name) ? name : "\"" + name + "\"";

        sealed class Entry
        {
            public string Name, Type, Address, Value, Comment;
            public bool Constant;
            public Dictionary<string, string> Flags = new Dictionary<string, string>(StringComparer.Ordinal);
            public int Line;
        }

        /// <summary>SimaticML for TIA Portal to import; the tags keep the order of the text. Errors name the line.</summary>
        public static string ToXml(string text, string tableName, string culture, string engineeringVersion)
        {
            var entries = Parse(text);
            var id = 0;
            string Id() => (id++).ToString("X");
            var list = new XElement("ObjectList");
            var tableEl = new XElement("SW.Tags.PlcTagTable", new XAttribute("ID", Id()), new XElement("AttributeList", new XElement("Name", tableName)));
            foreach (var e in entries)
            {
                var attrs = new XElement("AttributeList", new XElement("DataTypeName", e.Type));
                if (e.Constant) attrs.Add(new XElement("Name", e.Name), new XElement("Value", e.Value));
                else
                {
                    foreach (var k in External) if (e.Flags.TryGetValue(k, out var f)) attrs.Add(new XElement(k, f));
                    attrs.Add(new XElement("LogicalAddress", e.Address), new XElement("Name", e.Name));
                }
                var el = new XElement(e.Constant ? Constants : Tags, new XAttribute("ID", Id()), new XAttribute("CompositionName", e.Constant ? "UserConstants" : "Tags"), attrs);
                if (e.Comment != null)
                    el.Add(new XElement("ObjectList",
                        new XElement("MultilingualText", new XAttribute("ID", Id()), new XAttribute("CompositionName", "Comment"),
                            new XElement("ObjectList",
                                new XElement("MultilingualTextItem", new XAttribute("ID", Id()), new XAttribute("CompositionName", "Items"),
                                    new XElement("AttributeList", new XElement("Culture", culture), new XElement("Text", e.Comment)))))));
                list.Add(el);
            }
            if (list.HasElements) tableEl.Add(list);
            var doc = new XDocument(new XDeclaration("1.0", "utf-8", null), new XElement("Document", new XElement("Engineering", new XAttribute("version", engineeringVersion)), tableEl));
            var sb = new StringBuilder();
            using (var w = XmlWriter.Create(new StringWriterUtf8(sb), new XmlWriterSettings { Indent = true, IndentChars = "  ", Encoding = new UTF8Encoding(false) }))
                doc.Save(w);
            return sb.ToString();
        }

        sealed class StringWriterUtf8 : StringWriter
        {
            public StringWriterUtf8(StringBuilder sb) : base(sb) { }
            public override Encoding Encoding => new UTF8Encoding(false);
        }

        static List<Entry> Parse(string text)
        {
            var entries = new List<Entry>();
            var seen = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            string section = null; // "tags" | "constants"
            var lines = text.TrimStart('\uFEFF').Replace("\r\n", "\n").Split('\n');
            for (var n = 1; n <= lines.Length; n++)
            {
                var (code, comment) = SplitComment(lines[n - 1], n);
                if (code.Length == 0) continue; // blank, or a comment of its own
                var word = Regex.Replace(code, @"\s+", " ").ToUpperInvariant();
                if (word == "VAR_GLOBAL" || word == "VAR_GLOBAL CONSTANT")
                {
                    if (section != null) throw Error(n, "VAR_GLOBAL before the END_VAR of the section above");
                    section = word == "VAR_GLOBAL" ? "tags" : "constants";
                    continue;
                }
                if (word == "END_VAR")
                {
                    if (section == null) throw Error(n, "END_VAR without VAR_GLOBAL");
                    section = null;
                    continue;
                }
                if (section == null && word.StartsWith("VAR", StringComparison.Ordinal)) throw Error(n, code + ": a tag table has the sections VAR_GLOBAL and VAR_GLOBAL CONSTANT");
                if (section == null) throw Error(n, "a tag belongs between VAR_GLOBAL and END_VAR");
                var e = Declaration(code, n, section == "constants");
                e.Comment = comment;
                if (seen.TryGetValue(e.Name, out var first)) throw Error(n, e.Name + " is declared twice (line " + first + ")");
                seen[e.Name] = n;
                entries.Add(e);
            }
            if (section != null) throw Error(lines.Length, "END_VAR is missing");
            return entries;
        }

        static TagTableTextException Error(int line, string message) => new TagTableTextException("line " + line + ": " + message, line);

        /// <summary>Code and the text of a trailing // comment; quotes ('…', "…") are respected.</summary>
        static (string Code, string Comment) SplitComment(string line, int n)
        {
            char quote = '\0';
            for (var i = 0; i < line.Length; i++)
            {
                var c = line[i];
                if (quote != '\0') { if (c == quote) quote = '\0'; else if (c == '$' && quote == '\'') i++; continue; }
                if (c == '\'' || c == '"') quote = c;
                else if (c == '/' && i + 1 < line.Length && line[i + 1] == '/')
                {
                    var comment = line.Substring(i + 2).Trim();
                    return (line.Substring(0, i).Trim(), comment.Length == 0 ? null : comment);
                }
                else if (c == '(' && i + 1 < line.Length && line[i + 1] == '*') throw Error(n, "use // for a comment, it belongs to the tag on its line");
            }
            if (quote != '\0') throw Error(n, "a quote is not closed");
            return (line.Trim(), null);
        }

        static Entry Declaration(string code, int n, bool constant)
        {
            var e = new Entry { Line = n, Constant = constant };
            if (!code.EndsWith(";", StringComparison.Ordinal)) throw Error(n, "missing ';' (one tag per line)");
            var s = code.Substring(0, code.Length - 1).TrimEnd();
            // a second declaration on the line would otherwise end up in the data type or value of the first
            var semicolon = IndexOutsideQuotes(s, ";");
            if (semicolon >= 0 && s.Substring(semicolon + 1).Trim().Length == 0) throw Error(n, "one ';' too many");
            if (semicolon >= 0) throw Error(n, "one tag per line: " + s.Substring(semicolon + 1).Trim() + "; goes on a line of its own");
            var i = 0;
            if (s.StartsWith("\"", StringComparison.Ordinal))
            {
                var close = s.IndexOf('"', 1);
                if (close <= 1) throw Error(n, "expected a tag name");
                e.Name = s.Substring(1, close - 1);
                i = close + 1;
            }
            else
            {
                while (i < s.Length && (char.IsLetterOrDigit(s[i]) || s[i] == '_')) i++;
                e.Name = s.Substring(0, i);
                // letters of any language, as the language server reads names (the text writes those in quotes)
                if (!Word.IsMatch(e.Name)) throw Error(n, "expected a tag name (a name with spaces or other characters goes in double quotes)");
            }
            var rest = s.Substring(i).TrimStart();
            if (rest.StartsWith("{", StringComparison.Ordinal))
            {
                var close = rest.IndexOf('}');
                if (close < 0) throw Error(n, "'}' is missing");
                if (constant) throw Error(n, "a constant has no HMI settings");
                foreach (var part in rest.Substring(1, close - 1).Split(';').Select(p => p.Trim()).Where(p => p.Length > 0))
                {
                    var m = Regex.Match(part, @"^(\w+)\s*:=\s*'(\w+)'$");
                    var key = m.Success ? External.FirstOrDefault(k => string.Equals(k, m.Groups[1].Value, StringComparison.OrdinalIgnoreCase)) : null;
                    var value = m.Success ? m.Groups[2].Value.ToLowerInvariant() : null;
                    if (key == null || (value != "true" && value != "false")) throw Error(n, "unknown setting " + part + " (" + string.Join(", ", External.Select(k => k + " := 'false'")) + ")");
                    e.Flags[key] = value;
                }
                rest = rest.Substring(close + 1).TrimStart();
            }
            // the address ends where the ':' of the type starts (AT %M0.0: Bool), as the language server reads it;
            // a ':P' right after it is peripheral access, which a tag table has not
            var at = Regex.Match(rest, @"^AT(?![A-Za-z0-9_])\s*([^\s:]+(?::[Pp](?![A-Za-z0-9_]))?)\s*", RegexOptions.IgnoreCase);
            if (at.Success)
            {
                if (constant) throw Error(n, "a constant has no address");
                e.Address = at.Groups[1].Value;
                if (!Address.IsMatch(e.Address)) throw Error(n, e.Address + " is not an address such as %I0.0, %QW4 or %MD10");
                rest = rest.Substring(at.Length);
            }
            else if (!constant) throw Error(n, e.Name + " has no address: a PLC tag is at an address (" + e.Name + " AT %M10.0 : Bool;)");
            if (!rest.StartsWith(":", StringComparison.Ordinal) || rest.StartsWith(":=", StringComparison.Ordinal)) throw Error(n, "expected ':' and the data type after " + e.Name);
            rest = rest.Substring(1);
            var assign = IndexOutsideQuotes(rest, ":=");
            if (constant)
            {
                if (assign < 0) throw Error(n, "a constant needs a value: " + e.Name + " : Int := 10;");
                e.Type = rest.Substring(0, assign).Trim();
                e.Value = rest.Substring(assign + 2).Trim();
                if (e.Value.Length == 0) throw Error(n, "a constant needs a value");
            }
            else
            {
                if (assign >= 0) throw Error(n, "a PLC tag has no start value in TIA Portal; constants go in VAR_GLOBAL CONSTANT");
                e.Type = rest.Trim();
            }
            if (e.Type.Length == 0) throw Error(n, "the data type of " + e.Name + " is missing");
            return e;
        }

        /// <summary>Where `what` is outside '…', "…" and the {…} of HMI settings, or -1.</summary>
        static int IndexOutsideQuotes(string s, string what)
        {
            char quote = '\0';
            for (var i = 0; i + what.Length <= s.Length; i++)
            {
                var c = s[i];
                if (quote != '\0') { if (c == quote) quote = '\0'; else if (c == '$' && quote == '\'') i++; continue; }
                if (c == '\'' || c == '"') quote = c;
                else if (c == '{') quote = '}';
                else if (string.CompareOrdinal(s, i, what, 0, what.Length) == 0) return i;
            }
            return -1;
        }
    }
}
