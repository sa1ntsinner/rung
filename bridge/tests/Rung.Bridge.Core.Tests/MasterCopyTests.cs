// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class MasterCopyTests
{
    static DescribeNode Node(string type, string name = null) => new DescribeNode { Type = type, Name = name ?? type, Attributes = new SortedDictionary<string, string>(StringComparer.Ordinal), Children = new SortedDictionary<string, List<DescribeNode>>(StringComparer.Ordinal) };
    static LibraryImportState State()
    {
        var library = Node("ProjectLibrary"); var folder = Node("MasterCopySystemFolder", "Master copies"); library.Children["MasterCopyFolder"] = new List<DescribeNode> { folder };
        return new LibraryImportState { Libraries = library, Hardware = Node("hardware"), Objects = new SortedDictionary<string, string>(StringComparer.Ordinal) { ["plc:PLC_1/blocks/Motor"] = "{}" } };
    }
    static void AddCopy(LibraryImportState state, string name) => state.Libraries.Children["MasterCopyFolder"][0].Children["MasterCopies"] = new List<DescribeNode> { Node("MasterCopy", name) };
    static MasterCopyRequest Create() => new MasterCopyRequest { Action = "create", Name = "Motor template", Device = "PLC_1", Block = "Motor" };
    static MasterCopyRequest Use() => new MasterCopyRequest { Action = "use", Name = "Motor template", Device = "PLC_1" };

    [Fact] public void CreatesOneMasterCopyAndNothingElse()
    {
        var state = State();
        var result = MasterCopyPlan.Apply(() => state, Create(), LibraryImportPlan.Revision(state), () => { AddCopy(state, "Motor template"); return null; }, work => work());
        Assert.Equal("Motor template", result.Name);
        state = State();
        Assert.Throws<RpcException>(() => MasterCopyPlan.Apply(() => state, Create(), LibraryImportPlan.Revision(state),
            () => { AddCopy(state, "Motor template"); state.Objects["plc:PLC_1/blocks/Motor"] = "{\"changed\":1}"; return null; }, work => work()));
        // a name already in the library refuses before TIA is asked
        state = State(); AddCopy(state, "Motor template");
        Assert.Throws<RpcException>(() => MasterCopyPlan.Apply(() => state, Create(), LibraryImportPlan.Revision(state), () => throw new Exception("not reached"), work => work()));
    }

    [Fact] public void UsingAMasterCopyAddsExactlyTheOneBlockItReports()
    {
        var state = State(); AddCopy(state, "Motor template");
        var result = MasterCopyPlan.Apply(() => state, Use(), LibraryImportPlan.Revision(state), () => { state.Objects["plc:PLC_1/blocks/Motor_1"] = "{}"; return "plc:PLC_1/blocks/Motor_1"; }, work => work());
        Assert.Equal("plc:PLC_1/blocks/Motor_1", result.Address);
        state = State(); AddCopy(state, "Motor template");
        Assert.Throws<RpcException>(() => MasterCopyPlan.Apply(() => state, Use(), LibraryImportPlan.Revision(state),
            () => { state.Objects["plc:PLC_1/blocks/Motor_1"] = "{}"; state.Objects["plc:PLC_1/blocks/Motor_DB"] = "{}"; return "plc:PLC_1/blocks/Motor_1"; }, work => work()));
        Assert.Throws<RpcException>(() => MasterCopyPlan.Check(new MasterCopyRequest { Action = "use", Name = "x", Device = "PLC_1", Block = "Motor" }));
    }
}
