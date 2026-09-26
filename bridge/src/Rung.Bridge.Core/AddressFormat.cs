// SPDX-License-Identifier: BUSL-1.1
// C# twin of packages/core/src/escape.ts + address.ts. Both are tested with docs/format/address-vectors.json.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Rung.Bridge.Core
{
    public sealed class AddressException : Exception
    {
        public AddressException(string message) : base(message) { }
    }

    public sealed class AddressParts
    {
        public string Device;
        public string Unit;
        public string Kind;
        public string[] Groups = new string[0];
        public string Name;
        public string Namespace;
    }

    public static class AddressFormat
    {
        const string Illegal = "/\\:*?\"<>|%~";
        static readonly Regex Reserved = new Regex(@"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex TrailingDotsSpaces = new Regex(@"[. ]+\z", RegexOptions.CultureInvariant);
        static readonly Regex BadPercent = new Regex(@"%(?![0-9A-F]{2})", RegexOptions.CultureInvariant);
        static readonly Regex Percent = new Regex(@"%([0-9A-F]{2})", RegexOptions.CultureInvariant);

        static readonly Dictionary<string, string> KindDir = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["block"] = "blocks", ["type"] = "types", ["tagtable"] = "tags",
            ["techobject"] = "techobjects", ["watchtable"] = "watch", ["forcetable"] = "force",
        };
        static readonly Dictionary<string, string> DirKind = KindDir.ToDictionary(kv => kv.Value, kv => kv.Key, StringComparer.Ordinal);

        static string Hex(char c) => "%" + ((int)c).ToString("X2");

        public static string EscapeSegment(string raw)
        {
            if (string.IsNullOrEmpty(raw) || !IsWellFormed(raw)) throw new AddressException("invalid segment");
            var sb = new StringBuilder(raw.Length + 8);
            foreach (var ch in raw)
                sb.Append(Illegal.IndexOf(ch) >= 0 || ch < 0x20 || ch == 0x7f ? Hex(ch) : ch.ToString());
            var outS = TrailingDotsSpaces.Replace(sb.ToString(), m => string.Concat(m.Value.Select(Hex)));
            if (Reserved.IsMatch(raw)) outS = Hex(outS[0]) + outS.Substring(1);
            return outS;
        }

        public static string UnescapeSegment(string escaped)
        {
            if (string.IsNullOrEmpty(escaped) || BadPercent.IsMatch(escaped)) throw new AddressException("invalid segment");
            var raw = Percent.Replace(escaped, m => ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString());
            string again;
            try { again = EscapeSegment(raw); } catch (AddressException) { throw new AddressException("invalid segment"); }
            if (!string.Equals(again, escaped, StringComparison.Ordinal)) throw new AddressException("noncanonical segment");
            return raw;
        }

        static bool IsWellFormed(string s)
        {
            for (var i = 0; i < s.Length; i++)
            {
                if (char.IsHighSurrogate(s[i])) { if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return false; i++; }
                else if (char.IsLowSurrogate(s[i])) return false;
            }
            return true;
        }

        static string Leaf(AddressParts a)
        {
            if (a.Namespace == null) return EscapeSegment(a.Name);
            if (a.Namespace.Length == 0) throw new AddressException("empty namespace");
            return EscapeSegment(a.Namespace) + "~" + EscapeSegment(a.Name);
        }

        public static string Format(AddressParts a)
        {
            if (a == null || a.Kind == null || !KindDir.ContainsKey(a.Kind) || a.Unit == "") throw new AddressException("invalid address");
            var segs = new List<string> { EscapeSegment(a.Device) };
            if (a.Unit != null) { segs.Add("units"); segs.Add(EscapeSegment(a.Unit)); }
            segs.Add(KindDir[a.Kind]);
            segs.AddRange((a.Groups ?? new string[0]).Select(EscapeSegment));
            segs.Add(Leaf(a));
            return "plc:" + string.Join("/", segs);
        }

        public static AddressParts Parse(string s)
        {
            try
            {
                if (s == null || !s.StartsWith("plc:", StringComparison.Ordinal)) throw new AddressException("prefix");
                var parts = s.Substring(4).Split('/');
                var i = 1;
                string unit = null;
                if (parts.Length > 1 && parts[1] == "units") { unit = UnescapeSegment(parts.Length > 2 ? parts[2] : ""); i = 3; }
                if (parts.Length < i + 2 || !DirKind.TryGetValue(parts[i], out var kind)) throw new AddressException("kind");
                var leaf = parts[parts.Length - 1];
                string ns = null, name;
                var t = leaf.IndexOf('~');
                if (t < 0) name = UnescapeSegment(leaf);
                else
                {
                    if (t == 0 || t == leaf.Length - 1 || leaf.IndexOf('~', t + 1) >= 0) throw new AddressException("leaf");
                    ns = UnescapeSegment(leaf.Substring(0, t));
                    name = UnescapeSegment(leaf.Substring(t + 1));
                }
                var a = new AddressParts
                {
                    Device = UnescapeSegment(parts[0]),
                    Unit = unit,
                    Kind = kind,
                    Groups = parts.Skip(i + 1).Take(parts.Length - i - 2).Select(UnescapeSegment).ToArray(),
                    Name = name,
                    Namespace = ns,
                };
                if (!string.Equals(Format(a), s, StringComparison.Ordinal)) throw new AddressException("noncanonical");
                return a;
            }
            catch (AddressException) { throw new AddressException("invalid address: " + s); }
        }
    }
}
