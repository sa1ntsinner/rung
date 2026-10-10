// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class HardwareModuleTests
{
    const string ModuleType = "OrderNumber:6ES7 521-1BH00-0AB0/V1.0";
    static DescribeNode Item(string name, int position, string type, bool builtIn = false) => new DescribeNode {
        Name = name, Type = "DeviceItem", Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal) {
            ["PositionNumber"] = position.ToString(), ["TypeIdentifier"] = type, ["IsBuiltIn"] = builtIn ? "true" : "false", ["Container"] = "→ Rail_0" } };
    static DescribeNode Tree() => new DescribeNode { Type = "Project", Children = new SortedDictionary<string, List<DescribeNode>> {
        ["Devices"] = new List<DescribeNode> { new DescribeNode { Name = "PLC_1", Children = new SortedDictionary<string, List<DescribeNode>> {
            ["DeviceItems"] = new List<DescribeNode> { Item("Rail_0", 0, "OrderNumber:6ES7 590-1***0-0AA0"), Item("CPU", 1, "CPU", true) } } } } } };
    static List<DescribeNode> Items(DescribeNode tree) => tree.Children["Devices"][0].Children["DeviceItems"];
    static HardwarePatch Patch(DescribeNode tree, string action = "create") => HardwarePlan.Parse(JsonDocument.Parse(JsonSerializer.Serialize(new {
        version = 2, expectedRevision = HardwarePlan.Revision(tree), module = new { action, device = "PLC_1", parentPositions = new[] { 0 },
            parentTypeIdentifier = "OrderNumber:6ES7 590-1***0-0AA0", typeIdentifier = ModuleType, position = 2, name = "New_DI" } })).RootElement);

    [Fact] public void ModuleSchemaAndIdentityAreStrictBeforeOpeningTia()
    {
        var tree = Tree(); var patch = Patch(tree);
        Assert.Equal(patch.ExpectedRevision, HardwarePlan.Preview(tree, patch).Revision);
        var opened = false;
        var dispatcher = new RpcDispatcher(() => { opened = true; return new FakeTiaSession(); }, new BridgeInfo("V20", "test"));
        var valid = JsonSerializer.Serialize(patch, RpcWire.Json);
        foreach (var bad in new[] { valid.Replace("\"version\":2", "\"version\":2,\"version\":2"),
            valid.Replace("\"action\":\"create\"", "\"action\":\"move\""), valid.Replace(ModuleType, "Other"),
            valid.Replace("\"position\":2", "\"position\":-1"), valid.Replace("\"module\":", "\"changes\":[],\"module\":"),
            valid.Replace("\"name\":\"New_DI\"", "\"name\":\"New_DI\",\"force\":true") })
        {
            var request = JsonSerializer.Serialize(new { id = 1, method = "hardware.preview", @params = new { patchText = bad } });
            var reply = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
            Assert.Equal(ErrorCodes.BadRequest, reply.GetProperty("error").GetProperty("code").GetString());
            Assert.False(opened);
        }
        patch.ExpectedRevision = "stale"; Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        patch = Patch(tree); patch.Module.ParentTypeIdentifier = "another"; Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        Items(tree).Add(Item("Existing", 2, ModuleType)); Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, Patch(tree)));
        patch = Patch(tree, "delete"); Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, patch));
        Items(tree)[2].Name = "New_DI"; Items(tree)[2].Attributes["IsBuiltIn"] = "true";
        Assert.Throws<RpcException>(() => HardwarePlan.Preview(tree, Patch(tree, "delete")));
    }
    [Fact] public void AnyCatalogueModuleInAFreeSlotAndAnyPluggedModuleCanBePreviewed()
    {
        var tree = Tree(); var patch = Patch(tree);
        patch.Module.TypeIdentifier = "OrderNumber:6ES7 522-1BH01-0AB0/V1.1"; patch.Module.Position = 3; patch.Module.Name = "DQ_16";
        Assert.Equal(patch.ExpectedRevision, HardwarePlan.Preview(tree, patch).Revision);
        Items(tree).Add(Item("AI_8", 4, "OrderNumber:6ES7 531-7KF00-0AB0/V2.1"));
        var delete = Patch(tree, "delete"); delete.Module.TypeIdentifier = "OrderNumber:6ES7 531-7KF00-0AB0/V2.1"; delete.Module.Position = 4; delete.Module.Name = "AI_8";
        Assert.Equal(HardwarePlan.Revision(tree), HardwarePlan.Preview(tree, delete).Revision);
    }
    [Fact] public void NativeGeneratedSubtreeIsAcceptedOnlyWhenTheRemainingGraphMatches()
    {
        var tree = Tree(); var before = HardwarePlan.Revision(tree); var patch = Patch(tree);
        var result = HardwarePlan.ApplyModule(() => tree, patch, () => {
            var created = Item("New_DI", 2, ModuleType); created.Attributes["InstallationDate"] = "native generated"; Items(tree).Add(created);
        }, work => work());
        Assert.Equal(HardwarePlan.Revision(tree), result.Revision);
        var removed = HardwarePlan.ApplyModule(() => tree, Patch(tree, "delete"), () => Items(tree).RemoveAt(2), work => work());
        Assert.Equal(before, removed.Revision);
        var writes = 0; patch = Patch(tree); patch.ExpectedRevision = "stale";
        Assert.Throws<RpcException>(() => HardwarePlan.ApplyModule(() => tree, patch, () => writes++, work => work())); Assert.Equal(0, writes);
    }
    [Fact] public void RpcModulePreviewAndApplyReachTheNativeSessionPath()
    {
        var fake = new FakeTiaSession { HardwareTree = Tree() };
        var dispatcher = new RpcDispatcher(() => fake, new BridgeInfo("V20", "test"));
        foreach (var method in new[] { "hardware.preview", "hardware.apply" })
        {
            var request = JsonSerializer.Serialize(new { id = 2, method, @params = new {
                patchText = JsonSerializer.Serialize(Patch(fake.HardwareTree), RpcWire.Json), operationId = Guid.NewGuid().ToString("D") } });
            var reply = JsonDocument.Parse(dispatcher.Handle(request)).RootElement;
            Assert.True(reply.TryGetProperty("result", out var result), reply.ToString());
            Assert.Equal("New_DI", result.GetProperty("module").GetProperty("name").GetString());
            Assert.Equal(method, fake.LastHardwareMethod);
        }
    }
    [Fact] public void SideEffectsRollBackAndFailedRollbackIsExplicit()
    {
        var tree = Tree(); var patch = Patch(tree); var before = patch.ExpectedRevision;
        Action change = () => { Items(tree).Add(Item("New_DI", 2, ModuleType)); Items(tree)[1].Name = "unexpected"; };
        var error = Assert.Throws<RpcException>(() => HardwarePlan.ApplyModule(() => tree, patch, change, work => {
            try { work(); } catch { tree = Tree(); throw; }
        }));
        Assert.Contains("restored", error.Message); Assert.Equal(before, HardwarePlan.Revision(tree));
        error = Assert.Throws<RpcException>(() => HardwarePlan.ApplyModule(() => tree, patch, () => { change(); throw new Exception("native failure"); }, work => work()));
        Assert.Contains("RESTORATION FAILED", error.Message);
    }
}

