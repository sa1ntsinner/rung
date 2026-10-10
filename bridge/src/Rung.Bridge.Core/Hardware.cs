// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
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
        /// <summary>A network node of the item at Positions (X1), by name: its IP address and the like.</summary>
        [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
        public string Node;
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
        /// <summary>Settings TIA Portal added or removed with a change (ClockMemoryByteAddress with ClockMemoryByte).</summary>
        public string[] Related;
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
            foreach (var change in patch.Changes)
            {
                var node = Find(expected, change);
                node.Attributes[change.Field] = change.After;
                if (change.Field == "Name") node.Name = change.After; // a renamed item shows its new name as well
            }
            var expectedRevision = Revision(expected);
            var related = new List<string>();
            try
            {
                transaction(() => {
                    foreach (var change in patch.Changes) set(change, change.After);
                    var actual = read();
                    related = Related(expected, actual, patch);
                    expectedRevision = Revision(expected);
                    if (Revision(actual) != expectedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Applied hardware differs from the requested graph: " + Unexpected(expected, actual)
                        + " (TIA Portal changes some settings together: to accept it, name that attribute in the patch too, with the value it gets)");
                });
                var after = read();
                if (Revision(after) != expectedRevision) throw new RpcException(ErrorCodes.ImportFailed, "Committed hardware differs from the requested graph");
                return new HardwarePreview { Revision = expectedRevision, Changes = patch.Changes, Related = related.Count > 0 ? related.ToArray() : null };
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

        /// <summary>
        /// A setting TIA Portal shows or hides with what was changed (ClockMemoryByte → ClockMemoryByteAddress): the
        /// expected graph takes it over from the actual one and the result names it. Anything else still differs.
        /// </summary>
        static List<string> Related(DescribeNode expected, DescribeNode actual, HardwarePatch patch)
        {
            var related = new List<string>();
            foreach (var change in patch.Changes)
            {
                DescribeNode e, a;
                try { e = Find(expected, change); a = Find(actual, change); } catch (RpcException) { continue; }
                if (e.Attributes == null || a.Attributes == null) continue;
                bool Dependent(string key) => key != change.Field && key.StartsWith(change.Field, StringComparison.Ordinal);
                foreach (var key in a.Attributes.Keys.Where(k => Dependent(k) && !e.Attributes.ContainsKey(k)).ToArray())
                {
                    e.Attributes[key] = a.Attributes[key];
                    if (a.AttributeInfo != null && a.AttributeInfo.TryGetValue(key, out var info)) { e.AttributeInfo = e.AttributeInfo ?? new SortedDictionary<string, DescribeAttributeInfo>(StringComparer.Ordinal); e.AttributeInfo[key] = info; }
                    related.Add(change.Device + "/" + e.Name + "." + key + " = " + a.Attributes[key] + " (added by TIA Portal)");
                }
                foreach (var key in e.Attributes.Keys.Where(k => Dependent(k) && !a.Attributes.ContainsKey(k)).ToArray())
                {
                    e.Attributes.Remove(key); e.AttributeInfo?.Remove(key);
                    related.Add(change.Device + "/" + e.Name + "." + key + " (removed by TIA Portal)");
                }
                // which of its attributes may be edited follows from the settings (a fixed port speed): metadata, not values
                if (JsonSerializer.Serialize(e.AttributeInfo, RpcWire.Json) != JsonSerializer.Serialize(a.AttributeInfo, RpcWire.Json))
                {
                    e.AttributeInfo = a.AttributeInfo == null ? null : new SortedDictionary<string, DescribeAttributeInfo>(a.AttributeInfo, a.AttributeInfo.Comparer);
                    related.Add(change.Device + "/" + e.Name + ": TIA Portal changed which settings can be edited");
                }
            }
            return related;
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
            // a network node of an interface (X1: its IP address) by its name
            if (change.Node != null)
            {
                if (node.Children == null || !node.Children.TryGetValue("NetworkNodes", out var nodes)) throw Invalid("The item at that slot has no network nodes");
                node = One(nodes.Where(n => n.Name == change.Node));
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
                if (!module.TryGetProperty("parentPositions", out var path) || path.ValueKind != JsonValueKind.Array || path.GetArrayLength() < 1 || path.GetArrayLength() > 4)
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
                Fields(change, new[] { "device", "positions", "node", "typeIdentifier", "field", "before", "after" });
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
                    || change.Positions.Any(p => p < 0 || p > 65535) || change.TypeIdentifier?.Length == 0 || change.TypeIdentifier?.Length > 256
                    || change.Before == null || change.After == null || change.Before.Length > 1024 || change.After.Length > 1024
                    || change.Before.Contains('\0') || change.After.Contains('\0')) throw Invalid("Invalid hardware change");
                // what names the hardware (its type, slot, catalogue entry) is not edited here: modules are plugged instead
                if (Identity.Contains(change.Field)) throw Invalid("Hardware field " + change.Field + " identifies the hardware and is not edited");
                var key = JsonSerializer.Serialize(new { change.Device, change.Positions, change.Node, change.Field }, RpcWire.Json);
                if (!seen.Add(key)) throw Invalid("Duplicate hardware change");
                if (change.Node != null && (change.Node.Length == 0 || change.Node.Length > 64)) throw Invalid("Invalid network node name");
                var node = Find(tree, change);
                // the type identity is the item's: a network node has none of its own
                var owner = change.Node == null ? node : Find(tree, new HardwareChange { Device = change.Device, Positions = change.Positions });
                // a built-in interface has no type identifier of its own: then the change names none either
                string type = null;
                if (owner.Attributes == null || (owner.Attributes.TryGetValue("TypeIdentifier", out type) ? type != change.TypeIdentifier : change.TypeIdentifier != null))
                    throw Invalid("Hardware type identity differs");
                if (!node.Attributes.TryGetValue(change.Field, out var before) || before != change.Before) throw Invalid("Hardware original value differs");
                if (node.AttributeInfo == null || !node.AttributeInfo.TryGetValue(change.Field, out var info) || info?.Access != "ReadWrite" || !Fits(info.Type, change.After))
                    throw Invalid("Hardware field " + change.Field + " is read-only, of a type rung does not edit yet, or " + change.After + " does not fit it");
            }
            return new HardwarePreview { Revision = revision, Changes = patch.Changes };
        }

        static readonly HashSet<string> Identity = new HashSet<string>(StringComparer.Ordinal) { "TypeIdentifier", "PositionNumber", "IsBuiltIn", "Container", "OrderNumber", "FirmwareVersion" };
        static readonly Dictionary<string, (decimal Min, decimal Max)> Integers = new Dictionary<string, (decimal, decimal)>(StringComparer.Ordinal) {
            ["System.Byte"] = (0, byte.MaxValue), ["System.SByte"] = (sbyte.MinValue, sbyte.MaxValue), ["System.Int16"] = (short.MinValue, short.MaxValue),
            ["System.UInt16"] = (0, ushort.MaxValue), ["System.Int32"] = (int.MinValue, int.MaxValue), ["System.UInt32"] = (0, uint.MaxValue),
            ["System.Int64"] = (long.MinValue, long.MaxValue), ["System.UInt64"] = (0, ulong.MaxValue) };

        /// <summary>The text a snapshot shows for a value of this type: strings, true/false, whole numbers in range.</summary>
        static bool Fits(string type, string text)
        {
            if (type == "System.String") return true;
            if (type == "System.Boolean") return text == "true" || text == "false";
            // an enumeration of the engineering API (TransmissionRateAndDuplex): a member name; the bridge checks it against the type
            if (type != null && type.StartsWith("Siemens.Engineering.", StringComparison.Ordinal)) return Regex.IsMatch(text, "^[A-Za-z_][A-Za-z0-9_]*$");
            return type != null && Integers.TryGetValue(type, out var range) && decimal.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n)
                && n == decimal.Truncate(n) && n >= range.Min && n <= range.Max && text == n.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>The text of a change as a value of the type the attribute holds now (Openness sets typed values).</summary>
        public static object As(object current, string text)
        {
            try
            {
                switch (current)
                {
                    case string _: return text;
                    case bool _ when text == "true" || text == "false": return text == "true";
                    case byte _: return byte.Parse(text, CultureInfo.InvariantCulture);
                    case sbyte _: return sbyte.Parse(text, CultureInfo.InvariantCulture);
                    case short _: return short.Parse(text, CultureInfo.InvariantCulture);
                    case ushort _: return ushort.Parse(text, CultureInfo.InvariantCulture);
                    case int _: return int.Parse(text, CultureInfo.InvariantCulture);
                    case uint _: return uint.Parse(text, CultureInfo.InvariantCulture);
                    case long _: return long.Parse(text, CultureInfo.InvariantCulture);
                    case ulong _: return ulong.Parse(text, CultureInfo.InvariantCulture);
                    case Enum e when Regex.IsMatch(text, "^[A-Za-z_][A-Za-z0-9_]*$") && Enum.IsDefined(e.GetType(), text): return Enum.Parse(e.GetType(), text);
                }
            }
            catch (Exception e) when (e is FormatException || e is OverflowException) { }
            throw Invalid("The value " + text + " does not fit a " + (current?.GetType().Name ?? "missing") + " attribute");
        }
    }
}
