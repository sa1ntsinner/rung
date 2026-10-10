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
    [Fact] public void EditsWritableBooleanIntegerAndNameFieldsWhenTheValueFitsTheType()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        item.Attributes["ClockMemoryByte"] = "false"; item.AttributeInfo["ClockMemoryByte"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.Boolean" };
        item.Attributes["CycleMaximumCycleTime"] = "150"; item.AttributeInfo["CycleMaximumCycleTime"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.UInt64" };
        item.Attributes["Name"] = "CPU"; item.AttributeInfo["Name"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.String" };
        HardwareChange Change(string field, string before, string after) => new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = field, Before = before, After = after };
        var patch = new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] { Change("ClockMemoryByte", "false", "true"), Change("CycleMaximumCycleTime", "150", "200"), Change("Name", "CPU", "Main_CPU") } };
        Assert.Equal(3, HardwarePlan.Preview(tree, patch).Changes.Length);
        foreach (var (field, before, after) in new[] { ("ClockMemoryByte", "false", "yes"), ("CycleMaximumCycleTime", "150", "-1"), ("CycleMaximumCycleTime", "150", "1.5") })
            Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, new HardwarePatch { Version = 1, ExpectedRevision = patch.ExpectedRevision, Changes = new[] { Change(field, before, after) } }));
        // a rename changes the node's own name too: the applied graph is checked with it
        var applied = HardwarePlan.Apply(() => tree, patch, (c, value) => { item.Attributes[c.Field] = value; if (c.Field == "Name") item.Name = value; }, work => work());
        Assert.Equal("Main_CPU", item.Name);
        Assert.Equal(HardwarePlan.Revision(tree), applied.Revision);
    }
    [Fact] public void AcceptsTheSettingTiaPortalShowsForWhatWasTurnedOnAndReportsIt()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        item.Attributes["ClockMemoryByte"] = "false"; item.AttributeInfo["ClockMemoryByte"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.Boolean" };
        var patch = new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] {
            new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = "ClockMemoryByte", Before = "false", After = "true" } } };
        void Set(HardwareChange c, string value)
        {
            item.Attributes[c.Field] = value;
            if (value == "true") { item.Attributes["ClockMemoryByteAddress"] = "0"; item.AttributeInfo["ClockMemoryByteAddress"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.Int32" }; }
            else { item.Attributes.Remove("ClockMemoryByteAddress"); item.AttributeInfo.Remove("ClockMemoryByteAddress"); }
        }
        var applied = HardwarePlan.Apply(() => tree, patch, Set, work => work());
        Assert.Equal(new[] { "PLC_1/CPU.ClockMemoryByteAddress = 0 (added by TIA Portal)" }, applied.Related);
        Assert.Equal(HardwarePlan.Revision(tree), applied.Revision);
    }
    [Fact] public void ReachesANetworkNodeOfAnInterfaceByItsName()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        var x1 = new DescribeNode { Type = "Node", Name = "X1", Attributes = new SortedDictionary<string, string> { ["Address"] = "192.168.0.1" },
            AttributeInfo = new SortedDictionary<string, DescribeAttributeInfo> { ["Address"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.String" } } };
        item.Children = new SortedDictionary<string, List<DescribeNode>> { ["NetworkNodes"] = new List<DescribeNode> { x1 } };
        var change = new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, Node = "X1", TypeIdentifier = "OrderNumber:CPU", Field = "Address", Before = "192.168.0.1", After = "192.168.0.10" };
        var patch = new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] { change } };
        Assert.Single(HardwarePlan.Preview(tree, patch).Changes);
        var applied = HardwarePlan.Apply(() => tree, patch, (c, value) => x1.Attributes[c.Field] = value, work => work());
        Assert.Equal("192.168.0.10", x1.Attributes["Address"]);
        Assert.Equal(HardwarePlan.Revision(tree), applied.Revision);
        // a built-in interface has no type identifier: the change names none
        item.Attributes.Remove("TypeIdentifier"); change.TypeIdentifier = null; change.Before = "192.168.0.10"; change.After = "192.168.0.11"; patch.ExpectedRevision = HardwarePlan.Revision(tree);
        Assert.Single(HardwarePlan.Preview(tree, patch).Changes);
        change.TypeIdentifier = "OrderNumber:CPU"; Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        change.TypeIdentifier = null;
        change.Node = "X9"; patch.ExpectedRevision = HardwarePlan.Revision(tree); change.Before = "192.168.0.10";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        Assert.NotNull(HardwarePlan.Parse(JsonDocument.Parse("{\"version\":1,\"changes\":[{\"device\":\"PLC_1\",\"positions\":[1],\"node\":\"X1\"}]}").RootElement));
    }
    [Fact] public void AcceptsChangedEditabilityOfTheChangedItemButNotChangedValues()
    {
        var tree = Fixture(); var item = tree.Children["Devices"][0].Children["DeviceItems"][0];
        item.Attributes["Speed"] = "Automatic"; item.AttributeInfo["Speed"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "Siemens.Engineering.HW.TransmissionRateAndDuplex" };
        item.Attributes["Duplex"] = "x"; item.AttributeInfo["Duplex"] = new DescribeAttributeInfo { Access = "ReadWrite", Type = "System.String" };
        var patch = new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] {
            new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = "Speed", Before = "Automatic", After = "TP100MbpsFullDuplex" } } };
        var applied = HardwarePlan.Apply(() => tree, patch, (c, v) => { item.Attributes[c.Field] = v; item.AttributeInfo["Duplex"] = new DescribeAttributeInfo { Access = v == "Automatic" ? "ReadWrite" : "Read", Type = "System.String" }; }, work => work());
        Assert.Contains("PLC_1/CPU: TIA Portal changed which settings can be edited", applied.Related);
        Assert.Throws<RpcException>(() => HardwarePlan.Apply(() => tree, new HardwarePatch { Version = 1, ExpectedRevision = HardwarePlan.Revision(tree), Changes = new[] {
            new HardwareChange { Device = "PLC_1", Positions = new[] { 1 }, TypeIdentifier = "OrderNumber:CPU", Field = "Speed", Before = "TP100MbpsFullDuplex", After = "Automatic" } } },
            (c, v) => { item.Attributes[c.Field] = v; item.Attributes["Duplex"] = "changed too"; }, work => work()));
    }
    [Fact] public void ConvertsTheTextToTheTypeOfTheCurrentValue()
    {
        Assert.Equal(true, HardwarePlan.As(false, "true"));
        Assert.Equal(200UL, HardwarePlan.As(150UL, "200"));
        Assert.Equal(-3, HardwarePlan.As(1, "-3"));
        Assert.Equal("y", HardwarePlan.As("x", "y"));
        Assert.Equal(DayOfWeek.Friday, HardwarePlan.As(DayOfWeek.Monday, "Friday"));
        Assert.Throws<RpcException>(() => HardwarePlan.As(DayOfWeek.Monday, "Holiday"));
        Assert.Throws<RpcException>(() => HardwarePlan.As(DayOfWeek.Monday, "5"));
        Assert.Throws<RpcException>(() => HardwarePlan.As(1.5, "2"));
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
        // interfaces sit at 32768 and above (PROFINET interface_2: 33024)
        patch = Patch(tree); patch.Changes[0].Positions = new[] { 33024 }; Assert.Contains("identity is missing", Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch)).Message);
    }
}
