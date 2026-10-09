// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;
using Rung.Online;
using Xunit;

namespace Rung.Online.Tests;

public sealed class WatchTableTests
{
    [Theory]
    [InlineData("19")]
    [InlineData("20")]
    [InlineData("21")]
    public void PreservesActualExportOrderDuplicatesCommentsAndDraftModifyValue(string version)
    {
        var table = WatchTable.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", $"watch-v{version}.xml")));
        Assert.Equal("V" + version, table.EngineeringVersion);
        Assert.Equal(7, table.Rows.Length);
        Assert.Equal("%M0.0", table.Rows[0].Address);
        Assert.Equal("Hex", table.Rows[1].DisplayFormat);
        Assert.Equal("\"Fx_Global\".Count", table.Rows[4].Name);
        Assert.Equal(table.Rows[4].Name, table.Rows[6].Name);
        Assert.Equal("17", table.Rows[4].ModifyValue);
        Assert.Equal("Fixture row 5", table.Rows[4].Comments["en-US"]);
        Assert.Equal("row:5", table.Rows[4].Key);
    }

    [Fact]
    public void RejectsForceTablesAndExternalEntitiesWithoutOpeningAConnection()
    {
        Assert.Equal(ErrorCodes.ReadOnly, Assert.Throws<RpcException>(() => WatchTable.Parse(
            "<Document><SW.WatchAndForceTables.PlcForceTable><AttributeList><Name>Force</Name></AttributeList></SW.WatchAndForceTables.PlcForceTable></Document>")).Code);
        Assert.Equal(ErrorCodes.BadRequest, Assert.Throws<RpcException>(() => WatchTable.Parse(
            "<!DOCTYPE Document [<!ENTITY secret SYSTEM 'file:///C:/Windows/win.ini'>]><Document>&secret;</Document>")).Code);
    }

    [Fact]
    public async Task ParserUsesTheRpcEnvelopeWithoutRequiringAPlcSession()
    {
        await using var dispatcher = new OnlineDispatcher(_ => throw new Exception("Parsing must never connect."));
        var response = await dispatcher.HandleAsync("{\"id\":1,\"method\":\"online.watchTable\",\"params\":{\"xml\":\"<Document><Engineering version='V20'/><SW.WatchAndForceTables.PlcWatchTable ID='0'><AttributeList><Name>Fx_Watch</Name></AttributeList></SW.WatchAndForceTables.PlcWatchTable></Document>\"}}");
        using var doc = System.Text.Json.JsonDocument.Parse(response);
        Assert.Equal("Fx_Watch", doc.RootElement.GetProperty("result").GetProperty("name").GetString());
        Assert.Empty(doc.RootElement.GetProperty("result").GetProperty("rows").EnumerateArray());
    }
}
