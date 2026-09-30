// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// A note, per import operation, that TIA Portal committed it, written right after the commit and before the
    /// compile. A rung that was stopped before it heard the answer asks for these on its next pass: only a send with a
    /// receipt can be what TIA Portal holds now; one without never landed (or its receipt was the last thing lost).
    /// Kept per Windows user, outside any project, and swept after 30 days.
    /// </summary>
    public static class Receipts
    {
        public static string Dir =>
            Environment.GetEnvironmentVariable("RUNG_RECEIPTS_DIR") is string d && d.Length > 0
                ? d
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rung", "receipts");

        static string FileOf(string operationId) =>
            Guid.TryParseExact(operationId, "D", out var g) ? Path.Combine(Dir, g.ToString("D")) : null;

        public static void Write(string operationId, string address)
        {
            var path = FileOf(operationId);
            if (path == null) return;
            try
            {
                Directory.CreateDirectory(Dir);
                File.WriteAllText(path, address);
                Sweep();
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        /// <summary>The operations of these that TIA Portal committed.</summary>
        public static string[] Landed(IEnumerable<string> operationIds) =>
            (operationIds ?? Enumerable.Empty<string>()).Where(id => FileOf(id) is string p && File.Exists(p)).ToArray();

        static void Sweep()
        {
            var old = DateTime.UtcNow.AddDays(-30);
            foreach (var f in Directory.EnumerateFiles(Dir))
                try { if (File.GetLastWriteTimeUtc(f) < old) File.Delete(f); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
        }
    }
}
