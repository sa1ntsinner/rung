// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml.Linq;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// Whether the SIMATIC SD form of a block keeps what its SimaticML export holds. TIA Portal V20 before Update 4
    /// writes no texts into SD (network titles and comments vanish on the round trip), and SD never keeps the OB type,
    /// so rung uses SimaticML for such blocks.
    /// </summary>
    public static class SdCheck
    {
        /// <summary>Non-empty texts of the SimaticML export (titles, comments, member comments) missing from the SD files.</summary>
        public static IReadOnlyList<string> MissingTexts(string simaticMl, string sdFiles)
        {
            XDocument doc;
            try { doc = XDocument.Parse(simaticMl); }
            catch (System.Xml.XmlException) { return new[] { "(unreadable SimaticML)" }; }
            var texts = doc.Descendants()
                .Where(e => (e.Name.LocalName == "Text" && e.Parent?.Name.LocalName == "AttributeList") || e.Name.LocalName == "MultiLanguageText")
                .Select(e => e.Value.Trim())
                .Where(t => t.Length > 0)
                .Distinct(StringComparer.Ordinal);
            var sd = Normalize(sdFiles);
            return texts.Where(t => t.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).Any(l => sd.IndexOf(l, StringComparison.Ordinal) < 0)).ToList();
        }

        /// <summary>OBs other than program-cycle OBs lose their type in SD (TIA imports every SD OB as program cycle).</summary>
        public static bool LosesObType(string simaticMl)
        {
            try
            {
                var ob = XDocument.Parse(simaticMl).Descendants().FirstOrDefault(e => e.Name.LocalName == "SW.Blocks.OB");
                if (ob == null) return false;
                var secondary = ob.Descendants().FirstOrDefault(e => e.Name.LocalName == "SecondaryType")?.Value;
                return !string.Equals(secondary, "ProgramCycle", StringComparison.Ordinal);
            }
            catch (System.Xml.XmlException) { return true; }
        }

        static string Normalize(string s) => (s ?? "").Replace("\r\n", "\n")
            .Replace("&amp;", "&").Replace("&lt;", "<").Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&apos;", "'");
    }
}
