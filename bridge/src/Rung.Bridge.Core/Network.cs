// SPDX-License-Identifier: BUSL-1.1
// The network settings of a PLC as a file (plc/<PLC>/hardware/network.yaml): IP address, subnet mask, router and
// PROFINET device name of each Ethernet interface of its station and of the IO devices on its IO systems.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Rung.Bridge.Core
{
    public sealed class InterfaceSettings
    {
        /// <summary>"PLC_1 / PROFINET interface_1": the module and its interface.</summary>
        public string Key;
        /// <summary>An IPv4 address, "dhcp", "other" (set another way) or what TIA Portal names another choice.</summary>
        public string Ip;
        public string SubnetMask;
        /// <summary>An IPv4 address or "none".</summary>
        public string Router;
        /// <summary>The PROFINET device name or "auto"; null for an interface without one.</summary>
        public string DeviceName;
        /// <summary>The name TIA Portal derives while DeviceName is "auto" (written as a comment).</summary>
        public string GeneratedName;
        /// <summary>Line of the section in a parsed file, and of each setting.</summary>
        public int Line;
        public Dictionary<string, int> Lines = new Dictionary<string, int>(StringComparer.Ordinal);

        /// <summary>"line 8: " for a setting (or its section) of a parsed file; "" otherwise.</summary>
        public string At(string field) => Lines.TryGetValue(field, out var l) ? "line " + l + ": " : Line > 0 ? "line " + Line + ": " : "";
    }

    public sealed class NetworkFormatException : Exception
    {
        public NetworkFormatException(string message) : base(message) { }
    }

    public static class NetworkYaml
    {
        public const string Auto = "auto";
        public const string None = "none";
        static readonly string[] Fields = { "ip", "subnetMask", "router", "deviceName" };
        // what Render writes for a choice: the name of TIA Portal's enumeration value, its first letter lowered
        static readonly Regex Choice = new Regex(@"^[a-z][A-Za-z0-9_]*$", RegexOptions.CultureInvariant);
        static readonly Regex Plain =new Regex(@"^[A-Za-z0-9_.\-/][A-Za-z0-9_.\- /()]*$", RegexOptions.CultureInvariant);

        public static string Render(string plc, IEnumerable<InterfaceSettings> interfaces)
        {
            var sb = new StringBuilder();
            sb.Append("# Network settings of ").Append(plc).Append(" and its IO devices. rung sync writes changes to TIA Portal;\n");
            sb.Append("# rung download --hw takes them to the devices.\n");
            sb.Append("#   ip: an address, dhcp, or other (set another way)   router: an address or none\n");
            sb.Append("#   deviceName: the PROFINET device name, or auto (TIA Portal derives it from the module name)\n");
            sb.Append("# The subnet mask and the router belong to the subnet: a change on one interface changes the others on it.\n");
            foreach (var i in interfaces)
            {
                sb.Append('\n').Append(Quote(i.Key, true)).Append(":\n");
                if (i.Ip != null) sb.Append("  ip: ").Append(Quote(i.Ip)).Append('\n');
                if (i.SubnetMask != null) sb.Append("  subnetMask: ").Append(Quote(i.SubnetMask)).Append('\n');
                if (i.Router != null) sb.Append("  router: ").Append(Quote(i.Router)).Append('\n');
                if (i.DeviceName != null)
                {
                    sb.Append("  deviceName: ").Append(Quote(i.DeviceName));
                    if (i.DeviceName == Auto && !string.IsNullOrEmpty(i.GeneratedName)) sb.Append("  # ").Append(i.GeneratedName);
                    sb.Append('\n');
                }
            }
            return sb.ToString();
        }

        static string Quote(string s, bool key = false) =>
            !key && Plain.IsMatch(s) && s.Trim() == s ? s : "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        /// <summary>Reads the file back; settings a section leaves out stay null (unchanged).</summary>
        public static List<InterfaceSettings> Parse(string text)
        {
            var list = new List<InterfaceSettings>();
            InterfaceSettings cur = null;
            var lines = text.TrimStart('\uFEFF').Replace("\r\n", "\n").Split('\n');
            for (var n = 1; n <= lines.Length; n++)
            {
                var line = StripComment(lines[n - 1], n).TrimEnd();
                if (line.Trim().Length == 0) continue;
                var indented = char.IsWhiteSpace(line[0]);
                var colon = ColonOf(line, n);
                var name = Unquote(line.Substring(0, colon).Trim(), n);
                var value = line.Substring(colon + 1).Trim();
                if (!indented)
                {
                    if (value.Length > 0) throw new NetworkFormatException("line " + n + ": an interface is a name followed by a colon, with its settings indented below it");
                    if (list.Any(i => i.Key == name)) throw new NetworkFormatException("line " + n + ": \"" + name + "\" appears twice");
                    list.Add(cur = new InterfaceSettings { Key = name, Line = n });
                    continue;
                }
                if (cur == null) throw new NetworkFormatException("line " + n + ": a setting outside an interface");
                var v = Unquote(value, n);
                if (v.Length == 0) throw new NetworkFormatException("line " + n + ": " + name + " has no value");
                if (Array.IndexOf(Fields, name) >= 0) cur.Lines[name] = n;
                switch (name)
                {
                    case "ip":
                        // a word is a choice: dhcp, other, or one only TIA Portal makes (viaIoController), kept as it is
                        if (!Choice.IsMatch(v)) Ipv4(v, n, "ip", "an IPv4 address such as 192.168.0.1, dhcp or other");
                        Once(cur.Ip, n, name); cur.Ip = v; break;
                    case "subnetMask":
                        Ipv4(v, n, "subnetMask", "a mask such as 255.255.255.0");
                        if (!IsMask(v)) throw new NetworkFormatException("line " + n + ": " + v + " is not a subnet mask (the ones must be contiguous, as in 255.255.255.0)");
                        Once(cur.SubnetMask, n, name); cur.SubnetMask = v; break;
                    case "router":
                        if (v != None) Ipv4(v, n, "router", "an IPv4 address or none");
                        Once(cur.Router, n, name); cur.Router = v; break;
                    case "deviceName":
                        if (v != Auto) DeviceNameCheck(v, n);
                        Once(cur.DeviceName, n, name); cur.DeviceName = v; break;
                    default:
                        throw new NetworkFormatException("line " + n + ": unknown setting " + name + " (" + string.Join(", ", Fields) + ")");
                }
            }
            return list;
        }

        static void Once(string existing, int n, string name)
        {
            if (existing != null) throw new NetworkFormatException("line " + n + ": " + name + " is set twice");
        }

        static string StripComment(string line, int n)
        {
            var inQuote = false;
            for (var i = 0; i < line.Length; i++)
            {
                if (line[i] == '\\' && inQuote) { i++; continue; }
                if (line[i] == '"') inQuote = !inQuote;
                else if (line[i] == '#' && !inQuote && (i == 0 || char.IsWhiteSpace(line[i - 1]))) return line.Substring(0, i);
            }
            if (inQuote) throw new NetworkFormatException("line " + n + ": a quote is not closed");
            return line;
        }

        static int ColonOf(string line, int n)
        {
            var inQuote = false;
            for (var i = 0; i < line.Length; i++)
            {
                if (line[i] == '\\' && inQuote) { i++; continue; }
                if (line[i] == '"') inQuote = !inQuote;
                else if (line[i] == ':' && !inQuote && (i + 1 == line.Length || line[i + 1] == ' ' || line[i + 1] == '\t')) return i;
            }
            throw new NetworkFormatException("line " + n + ": expected \"name: value\"");
        }

        static string Unquote(string s, int n)
        {
            if (s.Length < 2 || s[0] != '"') return s;
            if (s[s.Length - 1] != '"') throw new NetworkFormatException("line " + n + ": text after a closing quote");
            var sb = new StringBuilder();
            for (var i = 1; i < s.Length - 1; i++)
            {
                if (s[i] == '\\' && i + 1 < s.Length - 1) { sb.Append(s[++i]); continue; }
                if (s[i] == '"') throw new NetworkFormatException("line " + n + ": text after a closing quote");
                sb.Append(s[i]);
            }
            return sb.ToString();
        }

        static void Ipv4(string v, int n, string field, string expected)
        {
            if (!IsIpv4(v)) throw new NetworkFormatException("line " + n + ": " + field + " \"" + v + "\" is not " + expected);
        }

        public static bool IsIpv4(string v)
        {
            var parts = v.Split('.');
            return parts.Length == 4 && parts.All(p => p.Length > 0 && p.Length <= 3 && p.All(c => c >= '0' && c <= '9') && int.Parse(p, CultureInfo.InvariantCulture) <= 255);
        }

        static bool IsMask(string v)
        {
            var bits = v.Split('.').Aggregate(0u, (acc, p) => (acc << 8) | uint.Parse(p, CultureInfo.InvariantCulture));
            var inverted = ~bits;
            return (inverted & (inverted + 1)) == 0;
        }

        /// <summary>
        /// TIA Portal converts any name to a DNS-compatible one (PnDeviceNameConverted), so only what it
        /// refuses outright is checked here: length and control characters.
        /// </summary>
        static void DeviceNameCheck(string v, int n)
        {
            if (v.Length > 240) throw new NetworkFormatException("line " + n + ": a PROFINET device name has at most 240 characters");
            if (v.Any(char.IsControl)) throw new NetworkFormatException("line " + n + ": the device name contains a control character");
        }
    }
}
