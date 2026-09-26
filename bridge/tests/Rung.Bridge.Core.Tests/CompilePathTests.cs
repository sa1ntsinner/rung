// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core;
using Xunit;

// Shapes seen live on V20 (docs/facts/openness-v20.md, F7): PLC_1 > "Program blocks" > "Fx_Broken (FC3)" > "3".
public class CompilePathTests
{
    [Theory]
    [InlineData("Fx_Broken (FC3)", "Fx_Broken")]
    [InlineData("Motor/Valve 1 (FC5)", "Motor/Valve 1")]
    [InlineData("\"Quoted\" (FB2)", "Quoted")]
    [InlineData("Fx_Types", "Fx_Types")]
    public void NodeNamesAreBlockNames(string path, string name) => Assert.Equal(name, CompilePath.ObjectName(path));

    [Theory]
    [InlineData("3", 3)]
    [InlineData("12", 12)]
    public void NumericLeavesAreBodyLines(string path, int line)
    {
        var p = CompilePath.Leaf(path);
        Assert.Equal(line, p.BodyLine);
        Assert.Equal("body", p.Section);
    }

    [Fact] public void InterfaceLeaf()
    {
        var p = CompilePath.Leaf("Interface");
        Assert.Null(p.BodyLine);
        Assert.Equal("interface", p.Section);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("Network 2")]
    public void OtherLeavesCarryNoPosition(string path)
    {
        var p = CompilePath.Leaf(path);
        Assert.Null(p.BodyLine);
        Assert.Null(p.Section);
    }
}
