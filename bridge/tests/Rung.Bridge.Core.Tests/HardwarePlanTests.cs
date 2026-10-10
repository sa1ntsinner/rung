// SPDX-License-Identifier: BUSL-1.1
using System.Collections.Generic;
using System.Text.Json;
using System;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class HardwarePlanTests
{
    [Fact] public void HardwareOperationIdsCannotBeReusedOrMalformed()
    {
        var used = new HashSet<string>(); var id = Guid.NewGuid().ToString("D");
        Assert.Equal(id, HardwarePlan.StartOperation(id, used));
        Assert.Throws<RpcException>(() => HardwarePlan.StartOperation(id, used));
        Assert.Throws<RpcException>(() => HardwarePlan.StartOperation("not-uuid", used));
    }
    [Fact] public void AppliesOnlyAfterPreflightAndRestoresAfterASecondWriteFails()
    {
        var tree = Fixture(); var patch = Patch(tree);
        var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        item.Attributes["Author"] = "before";
        item.AttributeInfo["Author"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.String" };
        patch.ExpectedRevision = HardwarePlan.Revision(tree);
        patch.Changes = new[] { patch.Changes[0], new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = "Author", Before = "before", After = "after" } };
        var writes = 0;
        void Set(HardwareChange c, string value) { writes++; if (c.Field == "Author" && value == "after") throw new InvalidOperationException("second write failed"); item.Attributes[c.Field] = value; }
        var error = Assert.Throws<RpcException>(() => HardwarePlan.Apply(() => tree, patch, Set, work => work()));
        Assert.Contains("restored", error.Message);
        Assert.Equal(patch.ExpectedRevision, HardwarePlan.Revision(tree));
        Assert.True(writes > 2);
        patch.ExpectedRevision = "stale"; writes = 0;
        Assert.Throws<RpcException>(() => HardwarePlan.Apply(() => tree, patch, Set, work => work()));
        Assert.Equal(0, writes);
    }
    [Fact] public void VerifiesActualAppliedGraphAndReportsFailedRestoration()
    {
        var tree = Fixture(); var patch = Patch(tree); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        var applied = HardwarePlan.Apply(() => tree, patch, (c, value) => item.Attributes[c.Field] = value, work => work());
        Assert.Equal("edited", item.Attributes["Comment"]);
        Assert.Equal(HardwarePlan.Revision(tree), applied.Revision);
        tree = Fixture(); patch = Patch(tree); item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        var error = Assert.Throws<RpcException>(() => HardwarePlan.Apply(() => tree, patch, (c, value) => {
            if (value == c.Before) throw new InvalidOperationException("rollback failed");
            item.Attributes[c.Field] = value; throw new InvalidOperationException("write failed after setting");
        }, work => work()));
        Assert.Contains("RESTORATION FAILED", error.Message);
    }
    [Fact] public void ReportsUnexpectedAttributeChangesInsteadOfAcceptingThem()
    {
        var tree = Fixture(); var patch = Patch(tree); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        var error = Assert.Throws<RpcException>(() => HardwarePlan.Apply(() => tree, patch, (c, value) => {
            item.Attributes[c.Field] = value; item.Attributes["Extra"] = "side effect";
        }, work => work()));
        Assert.Contains("Extra", error.Message);
    }
    [Fact] public void ApplyPreservesOrdinalSnapshotKeyOrdering()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        item.AttributeInfo = new SortedDictionary<string, DescribeAttributeInfo>(item.AttributeInfo, StringComparer.Ordinal);
        item.AttributeInfo["aFlag"] = new DescribeAttributeInfo { Access = "Read" };
        item.AttributeInfo["BFlag"] = new DescribeAttributeInfo { Access = "Read" };
        var patch = Patch(tree);
        var result = HardwarePlan.Apply(() => tree, patch, (c, value) => item.Attributes[c.Field] = value, work => work());
        Assert.Equal(HardwarePlan.Revision(tree), result.Revision);
    }
    [Fact] public void InvalidRpcPatchDoesNotOpenTheProject()
    {
        var opened = false;
        var dispatcher = new RpcDispatcher(() => { opened = true; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        foreach (var patchText in new[] { "{", "{\"version\":1,\"unknown\":true,\"changes\":[]}" })
        {
            var request = JsonSerializer.Serialize(new { id = 1, method = "hardware.preview", @params = new { patchText } });
            var reply = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
            Assert.Equal(ErrorCodes.BadRequest, reply.GetProperty("error").GetProperty("code").GetString());
            Assert.False(opened);
        }
    }
    [Fact] public void RejectsUnknownAndDuplicatePatchFieldsBeforePreview()
    {
        foreach (var json in new[] { "{\"version\":1,\"version\":1,\"changes\":[]}", "{\"version\":1,\"apply\":true,\"changes\":[]}",
            "{\"version\":1,\"changes\":[{\"unknown\":1}]}" })
            Assert.Throws<RpcException>(() => HardwarePlan.Parse(JsonDocument.Parse(json).RootElement));
    }
    [Fact] public void RpcSnapshotAndPreviewUseTheExistingReadOnlyDescription()
    {
        var dispatcher = new RpcDispatcher(() => new FakeTiaSession(), new BridgeInfo("V20", "test"));
        var snapshot = JsonDocument.Parse(dispatcher.Handle("{\"id\":1,\"method\":\"hardware.snapshot\",\"params\":{}}")).RootElement;
        Assert.True(snapshot.TryGetProperty("result", out var result), snapshot.ToString());
        var revision = result.GetProperty("revision").GetString();
        var request = JsonSerializer.Serialize(new { id = 2, method = "hardware.preview", @params = new { patchText = JsonSerializer.Serialize(new { version = 1, expectedRevision = revision, changes = new object[0] }) } });
        var preview = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
        Assert.Equal(revision, preview.GetProperty("result").GetProperty("revision").GetString());
        Assert.Equal(0, preview.GetProperty("result").GetProperty("changes").GetArrayLength());
        request = JsonSerializer.Serialize(new { id = 3, method = "hardware.apply", @params = new { patchText = JsonSerializer.Serialize(new { version = 1, expectedRevision = revision, changes = new object[0] }), operationId = Guid.NewGuid().ToString("D") } });
        var apply = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
        Assert.True(apply.TryGetProperty("result", out _), apply.ToString());
    }
    static DescribeNode Fixture() => new DescribeNode { Type = "Project", Children = new SortedDictionary<string, List<DescribeNode>> {
        ["Devices"] = new List<DescribeNode> { new DescribeNode { Type = "Device", Name = "PLC_1", Children = new SortedDictionary<string, List<DescribeNode>> {
            ["DeviceItems"] = new List<DescribeNode> { new DescribeNode { Type = "DeviceItem", Name = "CPU", Attributes = new SortedDictionary<string, string> {
                ["PositionNumber"] = "1", ["TypeIdentifier"] = "OrderNumber:CPU", ["Comment"] = "original" },
                AttributeInfo = new SortedDictionary<string, DescribeAttributeInfo> { ["Comment"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.String" } } } } } } } } };
    static HardwarePatch Patch(DescribeNode tree) => new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] {
        new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = "Comment", Before = "original", After = "edited" } } };

    [Fact] public void PreviewsWithoutChangingTheHardwareSnapshot()
    {
        var tree = Fixture(); var patch = Patch(tree);
        var result = HardwarePlan.Preview(tree, patch);
        Assert.Equal(patch.ExpectedRevision, result.Revision); Assert.Single(result.Changes);
        Assert.Equal(patch.ExpectedRevision, HardwarePlan.Revision(tree));
    }
    [Fact] public void RefusesStaleRevisionIdentityOrOriginalValue()
    {
        var tree = Fixture(); var patch = Patch(tree); patch.ExpectedRevision = "stale";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); patch.Changes[0].TypeIdentifier = "another";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); patch.Changes[0].Before = "different";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
    }
    [Fact] public void RefusesUnknownReadonlyOrUnsupportedTypedFields()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        var patch = Patch(tree); patch.Changes[0].Field = "TypeIdentifier";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); item.AttributeInfo["Comment"].Access = "Read"; patch.ExpectedRevision = HardwarePlan.Revision(tree);
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        item.AttributeInfo["Comment"].Access = "ReadWrite"; item.AttributeInfo["Comment"].Type = "System.Int32";
        patch.ExpectedRevision = HardwarePlan.Revision(tree);
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
    }
    [Fact] public void RefusesDuplicateChangesAmbiguousSlotsAndTruncatedSnapshots()
    {
        var tree = Fixture(); var patch = Patch(tree); patch.Changes = new[] { patch.Changes[0], patch.Changes[0] };
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        tree = Fixture(); var items = tree.Children["Devices"][0].Children["DeviceItems"]; items.Add(Fixture().Children["Devices"][0].Children["DeviceItems"][0]);
        patch = Patch(tree); Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        tree = Fixture(); tree.Truncated = true; Assert.Throws<RpcException>(() => HardwarePlan.Revision(tree));
    }
    [Fact] public void RefusesMissingOversizedAndInvalidSchema()
    {
        var tree = Fixture(); Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, null));
        var patch = Patch(tree); patch.Version = 2; Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); patch.Changes[0].After = new string('x', 1025); Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); patch.Changes[0].Positions = new[] { -1 }; Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
    }
}
