// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core
{
    /// <summary>"create": a master copy of a PLC block in the project library; "use": a new block in a PLC from a master copy.</summary>
    public sealed class MasterCopyRequest { public string Action, Name, Device, Block; }
    public sealed class MasterCopyPreview { public MasterCopyRequest Request; public string Revision; }
    public sealed class MasterCopyResult { public string Action, Name, Address, Revision; public bool Saved; public string[] Warnings; }
    public static class MasterCopyPlan
    {
        static readonly Regex Name = new Regex(@"^[^\p{Cc}""/\\]{1,128}$");
        public static void Check(MasterCopyRequest request)
        {
            if (request == null || (request.Action != "create" && request.Action != "use") || request.Name == null || !Name.IsMatch(request.Name)
                || string.IsNullOrWhiteSpace(request.Device) || request.Device.Length > 128 || request.Device.Any(char.IsControl)
                || (request.Action == "create" ? request.Block == null || !Name.IsMatch(request.Block) : request.Block != null))
                throw new RpcException(ErrorCodes.BadRequest, "A master copy needs create (with a block) or use, a name and one PLC");
        }
        static int MasterCopies(DescribeNode node, string name)
        {
            if (node == null) return 0;
            var own = node.Type == "MasterCopy" && node.Name == name ? 1 : 0;
            return own + (node.Children?.Values.SelectMany(c => c).Sum(c => MasterCopies(c, name)) ?? 0);
        }
        static void RemoveMasterCopy(DescribeNode node, string name)
        {
            if (node?.Children == null) return;
            foreach (var key in node.Children.Keys.ToArray())
            {
                node.Children[key].RemoveAll(n => n.Type == "MasterCopy" && n.Name == name);
                foreach (var child in node.Children[key]) RemoveMasterCopy(child, name);
                if (node.Children[key].Count == 0) node.Children.Remove(key);
            }
        }
        /// <summary>
        /// Runs the native operation in a transaction and keeps it only when the one expected object appeared and nothing else
        /// changed: a new master copy of that name (create) or one new PLC block (use).
        /// </summary>
        public static MasterCopyResult Apply(Func<LibraryImportState> read, MasterCopyRequest request, string expectedRevision, Func<string> operation, Action<Action> transaction)
        {
            Check(request); LibraryImportPlan.CheckRevision(expectedRevision);
            var current = read(); var revision = LibraryImportPlan.Revision(current);
            var before = new LibraryImportState { Libraries = HardwarePlan.Copy(current.Libraries), Hardware = HardwarePlan.Copy(current.Hardware), Objects = new SortedDictionary<string, string>(current.Objects, StringComparer.Ordinal) };
            if (revision != expectedRevision) throw new RpcException(ErrorCodes.StaleRevision, "Project changed since the master copy preview");
            if (request.Action == "create" ? MasterCopies(before.Libraries, request.Name) != 0 : MasterCopies(before.Libraries, request.Name) != 1)
                throw new RpcException(ErrorCodes.BadRequest, request.Action == "create" ? "A master copy of that name already exists" : "No single master copy of that name exists");
            string address = null, validated = null;
            void Verify(LibraryImportState after)
            {
                var copy = new LibraryImportState { Libraries = HardwarePlan.Copy(after.Libraries), Hardware = after.Hardware, Objects = new SortedDictionary<string, string>(after.Objects, StringComparer.Ordinal) };
                var expected = new LibraryImportState { Libraries = HardwarePlan.Copy(before.Libraries), Hardware = before.Hardware, Objects = before.Objects };
                if (request.Action == "create")
                {
                    if (MasterCopies(after.Libraries, request.Name) != 1) throw new RpcException(ErrorCodes.ImportFailed, "TIA did not create the one master copy of that name");
                    RemoveMasterCopy(copy.Libraries, request.Name);
                }
                else
                {
                    var added = after.Objects.Keys.Except(before.Objects.Keys).ToArray();
                    if (added.Length != 1 || added[0] != address) throw new RpcException(ErrorCodes.ImportFailed, "TIA did not create exactly the one new block");
                    copy.Objects.Remove(address);
                }
                if (LibraryImportPlan.Revision(copy) != LibraryImportPlan.Revision(expected))
                    throw new RpcException(ErrorCodes.ImportFailed, "The master copy changed other project objects: " + LibraryReleasePlan.Difference(expected, copy));
            }
            try
            {
                transaction(() => { address = operation(); var actual = read(); Verify(actual); validated = LibraryImportPlan.Revision(actual); });
                var after = read(); Verify(after);
                if (LibraryImportPlan.Revision(after) != validated) throw new RpcException(ErrorCodes.ImportFailed, "Commit changed the validated master copy state");
                return new MasterCopyResult { Action = request.Action, Name = request.Name, Address = address, Revision = validated };
            }
            catch (Exception error)
            {
                try { if (LibraryImportPlan.Revision(read()) != revision) throw new InvalidOperationException("Original project state differs"); }
                catch (Exception restoration) { throw new RpcException(ErrorCodes.ImportFailed, "RESTORATION FAILED after master copy: " + restoration.Message + "; original error: " + error.Message); }
                throw new RpcException(ErrorCodes.ImportFailed, "Master copy refused; original state restored: " + error.Message);
            }
        }
    }
}
