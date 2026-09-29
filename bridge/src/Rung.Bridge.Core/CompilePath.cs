// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Globalization;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// Reads the Path of Openness compiler messages. V20 nests them as
    /// PLC > "Program blocks" > "Name (FC3)" > leaf, where the leaf path is the line number counted from the
    /// line after BEGIN ("3") or "Interface" for declaration errors.
    /// </summary>
    public static class CompilePath
    {
        public struct LeafInfo
        {
            public int? BodyLine;
            public string Section;   // "body" | "interface" | null
        }

        /// <summary>The object name of a node path such as "Fx_Broken (FC3)".</summary>
        public static string ObjectName(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            // no splitting on '/': block names may contain it ("Motor/Valve 1"), and V20 nests nodes instead of joining paths
            var last = path;
            var paren = last.LastIndexOf(" (", StringComparison.Ordinal);
            if (paren > 0 && last.EndsWith(")", StringComparison.Ordinal)) last = last.Substring(0, paren);
            return last.Trim().Trim('"');
        }

        public static LeafInfo Leaf(string path)
        {
            if (string.IsNullOrEmpty(path)) return default(LeafInfo);
            if (int.TryParse(path.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0)
                return new LeafInfo { BodyLine = n, Section = "body" };
            if (string.Equals(path.Trim(), "Interface", StringComparison.OrdinalIgnoreCase))
                return new LeafInfo { Section = "interface" };
            return default(LeafInfo);
        }
    }
}
