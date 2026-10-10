// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public sealed class LibraryImportState
    {
        public DescribeNode Libraries, Hardware;
        public SortedDictionary<string, string> Objects;
    }
    public sealed class LibraryImportResult
    {
        public string TypeGuid, VersionGuid, VersionNumber, State, Address, Revision;
        public bool Saved;
        public string[] Warnings;
    }
    public static class LibraryImportPlan
    {
        public static void CheckRevision(string revision)
        {
            if (revision == null || !Regex.IsMatch(revision, "^[0-9a-f]{64}$"))
                throw new RpcException(ErrorCodes.BadRequest, "Library revision must be a SHA256");
        }
        public static string Revision(LibraryImportState state)
        {
            if (state?.Objects == null || state.Objects.Count > 4096 || state.Objects.Any(o => string.IsNullOrEmpty(o.Key)
                || o.Key.Length > 1024 || o.Value == null || o.Value.Length > 65536))
                throw new RpcException(ErrorCodes.BadRequest, "Incomplete or oversized library import state");
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { libraries = HardwarePlan.Revision(state.Libraries),
                hardware = HardwarePlan.Revision(state.Hardware), objects = state.Objects }, RpcWire.Json));
            if (bytes.Length > 1048576) throw new RpcException(ErrorCodes.BadRequest, "Library import state exceeds size limit");
            return Bundle.Sha256(bytes);
        }
        static LibraryImportState Copy(LibraryImportState state) => new LibraryImportState { Libraries = HardwarePlan.Copy(state.Libraries),
            Hardware = HardwarePlan.Copy(state.Hardware), Objects = new SortedDictionary<string,string>(state.Objects, StringComparer.Ordinal) };
        static void Verify(LibraryImportState before, LibraryImportState after, LibraryPackage package, LibraryImportResult result)
        {
            Revision(after);
            if (result == null || result.TypeGuid != package.TypeGuid || result.State != "InWork" || result.VersionNumber != "0.0.1"
                || !Guid.TryParseExact(result.VersionGuid, "D", out var version) || version == Guid.Empty || result.VersionGuid == package.SourceVersionGuid
                || result.Address == null || before.Objects.ContainsKey(result.Address) || after.Objects.Count != before.Objects.Count + 1
                || !after.Objects.ContainsKey(result.Address)) throw new RpcException(ErrorCodes.ImportFailed, "Native library import produced an unexpected identity/state/object set");
            var reduced = Copy(after); var removed = 0;
            void Remove(DescribeNode node)
            {
                if (node.Children == null) return;
                foreach (var key in node.Children.Keys.ToArray())
                {
                    var children = node.Children[key];
                    removed += children.RemoveAll(n => n.Attributes != null && n.Attributes.TryGetValue("Guid", out var guid) && guid == package.TypeGuid);
                    foreach (var child in children) Remove(child);
                    if (children.Count == 0) node.Children.Remove(key);
                }
            }
            Remove(reduced.Libraries); reduced.Objects.Remove(result.Address);
            if (removed != 1 || Revision(reduced) != Revision(before))
                throw new RpcException(ErrorCodes.ImportFailed, "Native library import changed unreviewed project objects");
        }
        // Native owner holds exclusive access; transaction must dispose before returning.
        public static LibraryImportResult Apply(Func<LibraryImportState> read, LibraryPackage package, string expectedRevision,
            Func<LibraryImportResult> import, Action<Action> transaction)
        {
            CheckRevision(expectedRevision);
            var before = read(); var revision = Revision(before);
            if (revision != expectedRevision) throw new RpcException(ErrorCodes.StaleRevision, "Project changed since the library import preview");
            before = Copy(before); LibraryImportResult result = null; string validatedRevision = null;
            try
            {
                transaction(() => { result = import(); var actual = read(); Verify(before, actual, package, result); validatedRevision = Revision(actual); });
                var after = read(); Verify(before, after, package, result); result.Revision = Revision(after);
                if (result.Revision != validatedRevision) throw new RpcException(ErrorCodes.ImportFailed,"Native commit changed the validated library import state");
                return result;
            }
            catch (Exception error)
            {
                try { if (Revision(read()) != revision) throw new InvalidOperationException("Original project state differs"); }
                catch (Exception restoration) { throw new RpcException(ErrorCodes.ImportFailed, "RESTORATION FAILED after library import: " + restoration.Message + "; original error: " + error.Message); }
                throw new RpcException(ErrorCodes.ImportFailed, "Library import refused; original state restored: " + error.Message);
            }
        }
    }
}
