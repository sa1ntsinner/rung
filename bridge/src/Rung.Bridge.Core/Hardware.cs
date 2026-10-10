// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public sealed class HardwareChange
    {
        public string Device;
        public int[] Positions;
        public string TypeIdentifier;
        public string Field;
        public string Before;
        public string After;
    }
    public sealed class HardwarePatch
    {
        public int Version;
        public string ExpectedRevision;
        public HardwareChange[] Changes;
        public HardwareModule Module;
    }
    public sealed class HardwareModule
    {
        public string Action, Device, ParentTypeIdentifier, TypeIdentifier, Name;
        public int[] ParentPositions;
        public int Position;
    }
    public sealed class HardwarePreview
    {
        public string Revision;
        public HardwareChange[] Changes;
        public HardwareModule Module;
        public bool? Saved;
        public string[] Warnings;
    }

    /// <summary>Pure hardware preflight. It never calls an engineering setter.</summary>
    public static partial class HardwarePlan
    {
        static RpcException Invalid(string reason) => new RpcException(ErrorCodes.BadRequest, reason);
        public static string StartOperation(string operationId, ISet<string> used, string context = "Hardware")
        {
            if (!Guid.TryParseExact(operationId, "D", out var id)) throw Invalid("operationId must be a UUID");
            var key = id.ToString("D");
            if (used.Contains(key) || Receipts.Landed(new[] { key }).Length != 0) throw Invalid(context + " operationId was already used");
            used.Add(key);
            return key;
        }
        static string Unexpected(DescribeNode expected, DescribeNode actual)
        {
            var path = actual?.Name ?? actual?.Type ?? "hardware";
            if (expected == null || actual == null) return path;
            foreach (var key in (expected.Attributes?.Keys ?? Enumerable.Empty<string>()).Union(actual.Attributes?.Keys ?? Enumerable.Empty<string>()))
            {
                string before = null, after = null;
                expected.Attributes?.TryGetValue(key, out before); actual.Attributes?.TryGetValue(key, out after);
                if (before != after) return path + "." + key;
            }
            if (expected.Children != null) foreach (var c in expected.Children)
            {
                if (actual.Children == null || !actual.Children.TryGetValue(c.Key, out var children) || children.Count != c.Value.Count) return path + "." + c.Key;
                for (var i = 0; i < children.Count; i++)
                    if (JsonSerializer.Serialize(c.Value[i], RpcWire.Json) != JsonSerializer.Serialize(children[i], RpcWire.Json))
                        return path + "/" + Unexpected(c.Value[i], children[i]);
            }
            return path + " metadata";
        }
        internal static DescribeNode Copy(DescribeNode node)
        {
            var copy = new DescribeNode { Type = node.Type, Name = node.Name, Truncated = node.Truncated,
                Attributes = node.Attributes == null ? null : new SortedDictionary<string, string>(node.Attributes, node.Attributes.Comparer),
                AttributeInfo = node.AttributeInfo == null ? null : new SortedDictionary<string, DescribeAttributeInfo>(node.AttributeInfo, node.AttributeInfo.Comparer) };
            if (node.Children != null)
            {
                copy.Children = new SortedDictionary<string, List<DescribeNode>>(node.Children.Comparer);
                foreach (var c in node.Children) copy.Children[c.Key] = c.Value.Select(Copy).ToList();
            }
            return copy;
        }
        // Caller holds exclusive access throughout; each transaction returns only after commit/rollback disposal.
        public static HardwarePreview Apply(Func<DescribeNode> read, HardwarePatch patch, Action<HardwareChange, string> set, Action<Action> transaction)
        {
            var before = read();
            var preview = Preview(before, patch);
            var expected = Copy(before);
            foreach (var change in patch.Changes) Find(expected, change).Attributes[change.Field] = change.After;
            var expectedRevision = Revision(expected);
            try
            {
                transaction(() => {
                    foreach (var change in patch.Changes) set(change, change.After);
                    var actual = read();
                    if (Revision(actual) != expectedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Applied hardware differs from the requested graph: " + Unexpected(expected, actual));
                });
                var after = read();
                if (Revision(after) != expectedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Committed hardware differs from the requested graph");
                return new HardwarePreview { Revision = expectedRevision, Changes = patch.Changes };
            }
            catch (Exception error)
            {
                try
                {
                    if (Revision(read()) != preview.Revision)
                        transaction(() => { foreach (var change in patch.Changes.Reverse()) set(change, change.Before); });
                    if (Revision(read()) != preview.Revision) throw new InvalidOperationException("Original hardware graph differs");
                }
                catch (Exception restore) { throw new RpcException(ErrorCodes.ImportFailed, error.Message + "; RESTORATION FAILED: " + restore.Message); }
                throw new RpcException(ErrorCodes.ImportFailed, error.Message + "; original hardware restored");
            }
        }

        static DescribeNode Find(DescribeNode tree, HardwareChange change)
        {
            DescribeNode One(IEnumerable<DescribeNode> nodes)
            {
                var found = nodes.Take(2).ToArray();
                if (found.Length != 1) throw Invalid("Hardware identity is missing or ambiguous");
                return found[0];
            }
            if (tree.Children == null || !tree.Children.TryGetValue("Devices", out var devices)) throw Invalid("Missing hardware devices");
            var node = One(devices.Where(d => d.Name == change.Device));
            foreach (var position in change.Positions)
            {
                if (node.Children == null || !node.Children.TryGetValue("DeviceItems", out var items)) throw Invalid("Missing hardware slot");
                node = One(items.Where(i => i.Attributes != null && i.Attributes.TryGetValue("PositionNumber", out var p)
                    && int.TryParse(p, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n == position));
            }
            return node;
        }
        public static HardwarePatch Parse(JsonElement value)
        {
            void Fields(JsonElement obj, string[] allowed)
            {
                if (obj.ValueKind != JsonValueKind.Object) throw Invalid("Hardware patch must contain objects");
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var p in obj.EnumerateObject())
                    if (Array.IndexOf(allowed, p.Name) < 0 || !names.Add(p.Name)) throw Invalid("Unknown or duplicate hardware field " + p.Name);
            }
            if (value.ValueKind == JsonValueKind.Object && value.TryGetProperty("version", out var version)
                && version.ValueKind == JsonValueKind.Number && version.TryGetInt32(out var v) && v == 2)
            {
                Fields(value, new[] { "version", "expectedRevision", "module" });
                if (!value.TryGetProperty("module", out var module)) throw Invalid("Missing hardware module");
                Fields(module, new[] { "action", "device", "parentPositions", "parentTypeIdentifier", "typeIdentifier", "position", "name" });
                if (!module.TryGetProperty("parentPositions", out var path) || path.ValueKind != JsonValueKind.Array || path.GetArrayLength() != 1)
                    throw Invalid("Unsupported module parent path");
                HardwarePatch parsed;
                try { parsed = JsonSerializer.Deserialize<HardwarePatch>(value.GetRawText(), RpcWire.Json); }
                catch (JsonException e) { throw Invalid("Invalid hardware module patch: " + e.Message); }
                ValidateModule(parsed);
                return parsed;
            }
            Fields(value, new[] { "version", "expectedRevision", "changes" });
            if (!value.TryGetProperty("changes", out var changes) || changes.ValueKind != JsonValueKind.Array || changes.GetArrayLength() > 256)
                throw Invalid("Invalid hardware changes");
            foreach (var change in changes.EnumerateArray())
            {
                Fields(change, new[] { "device", "positions", "typeIdentifier", "field", "before", "after" });
                if (change.TryGetProperty("positions", out var positions) && (positions.ValueKind != JsonValueKind.Array || positions.GetArrayLength() > 12))
                    throw Invalid("Invalid hardware positions");
            }
            try { return JsonSerializer.Deserialize<HardwarePatch>(value.GetRawText(), RpcWire.Json); }
            catch (JsonException e) { throw Invalid("Invalid hardware patch: " + e.Message); }
        }
        public static string Revision(DescribeNode tree)
        {
            var seen = new HashSet<DescribeNode>(); var textSize = 0;
            void Text(string s) { textSize += s?.Length ?? 0; if (textSize > 131072) throw Invalid("Hardware snapshot size limit exceeded"); }
            void Walk(DescribeNode node, int depth)
            {
                if (node == null || node.Truncated == true || depth > 12 || !seen.Add(node) || seen.Count > 4096)
                    throw Invalid("Incomplete, ambiguous or oversized hardware snapshot");
                Text(node.Type); Text(node.Name);
                if ((node.Attributes?.Count ?? 0) > 1024 || (node.AttributeInfo?.Count ?? 0) > 1024) throw Invalid("Hardware attribute limit exceeded");
                if (node.Attributes != null) foreach (var a in node.Attributes) { Text(a.Key); Text(a.Value); }
                if (node.AttributeInfo != null) foreach (var a in node.AttributeInfo) { Text(a.Key); Text(a.Value?.Access); Text(a.Value?.Type); }
                if (node.Children == null) return;
                foreach (var c in node.Children) { Text(c.Key); if (c.Value == null) throw Invalid("Missing hardware composition"); foreach (var child in c.Value) Walk(child, depth + 1); }
            }
            Walk(tree, 0);
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(tree, RpcWire.Json)))).Replace("-", "").ToLowerInvariant();
        }

        public static HardwarePreview Preview(DescribeNode tree, HardwarePatch patch)
        {
            var revision = Revision(tree);
            if (patch?.Version == 2) return PreviewModule(tree, patch, revision);
            if (patch == null || patch.Version != 1 || patch.Changes == null || patch.Changes.Length > 256) throw Invalid("Invalid hardware patch schema");
            if (patch.ExpectedRevision != revision) throw new RpcException(ErrorCodes.StaleRevision, "Hardware changed since its snapshot");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var change in patch.Changes)
            {
                if (change == null || string.IsNullOrEmpty(change.Device) || change.Device.Length > 128 || change.Positions == null || change.Positions.Length > 12
                    || change.Positions.Any(p => p < 0 || p > 32767) || string.IsNullOrEmpty(change.TypeIdentifier) || change.TypeIdentifier.Length > 256
                    || change.Before == null || change.After == null || change.Before.Length > 1024 || change.After.Length > 1024
                    || change.Before.Contains('\0') || change.After.Contains('\0')) throw Invalid("Invalid hardware change");
                // ponytail: only proven string annotations; rename/module creation require their own validated apply path.
                if (change.Field != "Comment" && change.Field != "Author") throw Invalid("Unsupported hardware field " + change.Field);
                var key = JsonSerializer.Serialize(new { change.Device, change.Positions, change.Field }, RpcWire.Json);
                if (!seen.Add(key)) throw Invalid("Duplicate hardware change");
                var node = Find(tree, change);
                if (node.Attributes == null || !node.Attributes.TryGetValue("TypeIdentifier", out var type) || type != change.TypeIdentifier)
                    throw Invalid("Hardware type identity differs");
                if (!node.Attributes.TryGetValue(change.Field, out var before) || before != change.Before) throw Invalid("Hardware original value differs");
                if (node.AttributeInfo == null || !node.AttributeInfo.TryGetValue(change.Field, out var info)
                    || info?.Access != "ReadWrite" || info.Type != "System.String") throw Invalid("Hardware field is read-only or has an unsupported type");
            }
            return new HardwarePreview { Revision = revision, Changes = patch.Changes };
        }
    }
}
