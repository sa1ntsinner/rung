// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public static partial class HardwarePlan
    {
        static void ValidateModule(HardwarePatch patch)
        {
            var m = patch.Module;
            // any catalogue module: TIA Portal itself says whether it plugs there (CanPlugNew, in the bridge), and the
            // committed graph must differ from the snapshot by exactly that module, else it is rolled back
            if (patch.Version != 2 || patch.Changes != null || m == null || (m.Action != "create" && m.Action != "delete")
                || m.TypeIdentifier == null || m.TypeIdentifier.Length > 256 || !Regex.IsMatch(m.TypeIdentifier, @"^(OrderNumber|GSD|System):[^\0\r\n]+$")
                || m.Position < 0 || m.Position > 65535
                || m.ParentPositions == null || m.ParentPositions.Length < 1 || m.ParentPositions.Length > 4 || m.ParentPositions.Any(p => p < 0 || p > 65535)
                || string.IsNullOrEmpty(m.ParentTypeIdentifier) || m.ParentTypeIdentifier.Length > 256
                || string.IsNullOrEmpty(m.Device) || m.Device.Length > 128 || m.Device.Contains('\0')
                || string.IsNullOrEmpty(m.Name) || m.Name.Length > 64 || !m.Name.All(c => c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_')
                || string.IsNullOrEmpty(patch.ExpectedRevision) || patch.ExpectedRevision.Length != 64)
                throw Invalid("Unsupported hardware module patch");
        }
        /// <summary>A rack's modules are items of the device next to the rack (their Container names it); deeper ones are items of their parent.</summary>
        static List<DescribeNode> ModuleItems(DescribeNode tree, HardwareModule m)
        {
            var owner = Find(tree, new HardwareChange { Device = m.Device, Positions = m.ParentPositions.Length == 1 ? new int[0] : m.ParentPositions });
            if (owner.Children == null || !owner.Children.TryGetValue("DeviceItems", out var items)) throw Invalid("Missing module composition");
            return items;
        }
        static string ParentName(DescribeNode tree, HardwareModule m) => Find(tree, new HardwareChange { Device = m.Device, Positions = m.ParentPositions }).Name;
        static bool At(DescribeNode node, int position) => node.Attributes != null && node.Attributes.TryGetValue("PositionNumber", out var value) && value == position.ToString(System.Globalization.CultureInfo.InvariantCulture);
        static void ModuleIdentity(DescribeNode node, HardwareModule m, string parent)
        {
            if (node.Name != m.Name || node.Attributes == null || !node.Attributes.TryGetValue("TypeIdentifier", out var type) || type != m.TypeIdentifier
                || !node.Attributes.TryGetValue("IsBuiltIn", out var builtIn) || builtIn != "false"
                || !node.Attributes.TryGetValue("Container", out var container) || container != "→ " + parent) throw Invalid("Module identity or container differs");
        }
        static HardwarePreview PreviewModule(DescribeNode tree, HardwarePatch patch, string revision)
        {
            ValidateModule(patch);
            if (patch.ExpectedRevision != revision) throw new RpcException(ErrorCodes.StaleRevision, "Hardware changed since its snapshot");
            var m = patch.Module;
            var parent = Find(tree, new HardwareChange { Device = m.Device, Positions = m.ParentPositions });
            if (parent.Attributes == null || !parent.Attributes.TryGetValue("TypeIdentifier", out var type) || type != m.ParentTypeIdentifier)
                throw Invalid("Module parent identity differs");
            var items = ModuleItems(tree, m); var matches = items.Where(i => At(i, m.Position)).ToArray();
            if (m.Action == "create")
            {
                if (matches.Length != 0 || items.Any(i => i.Name == m.Name)) throw Invalid("Module slot or name is occupied");
            }
            else
            {
                if (matches.Length != 1 || items.Count(i => i.Name == m.Name) != 1) throw Invalid("Module is missing or ambiguous");
                ModuleIdentity(matches[0], m, parent.Name);
            }
            return new HardwarePreview { Revision = revision, Module = m };
        }
        // Caller holds one native connection/exclusive access. Native rollback is authoritative; never recreate configured modules from defaults.
        public static HardwarePreview ApplyModule(Func<DescribeNode> read, HardwarePatch patch, Action mutate, Action<Action> transaction)
        {
            var before = Copy(read()); var preview = Preview(before, patch); var m = patch.Module;
            var expected = Copy(before);
            if (m.Action == "delete") ModuleItems(expected, m).RemoveAll(i => At(i, m.Position));
            var expectedRevision = Revision(expected); string committedRevision = null;
            try
            {
                transaction(() => {
                    mutate();
                    var actual = read(); committedRevision = Revision(actual);
                    var remainder = Copy(actual);
                    if (m.Action == "create")
                    {
                        var items = ModuleItems(remainder, m); var created = items.Where(i => At(i, m.Position)).ToArray();
                        if (created.Length != 1 || items.Count(i => i.Name == m.Name) != 1) throw Invalid("Created module is missing or ambiguous");
                        ModuleIdentity(created[0], m, ParentName(remainder, m)); items.Remove(created[0]);
                    }
                    if (Revision(remainder) != expectedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Module operation changed unrelated hardware");
                });
                if (Revision(read()) != committedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Committed module graph differs");
                return new HardwarePreview { Revision = committedRevision, Module = m };
            }
            catch (Exception error)
            {
                try { if (Revision(read()) != preview.Revision) throw new InvalidOperationException("Original hardware graph differs"); }
                catch (Exception restore) { throw new RpcException(ErrorCodes.ImportFailed, error.Message + "; RESTORATION FAILED: " + restore.Message); }
                throw new RpcException(ErrorCodes.ImportFailed, error.Message + "; original hardware restored");
            }
        }
    }
}
