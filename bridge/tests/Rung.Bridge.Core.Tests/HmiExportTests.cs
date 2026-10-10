// SPDX-License-Identifier: BUSL-1.1
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class HmiExportTests
{
    [Fact]
    public void ExportsAPanelsTagTablesAndScreensAsTheyAreAndRefusesABadDevice()
    {
        var fake = new FakeTiaSession();
        var dispatcher = new RpcDispatcher(() => fake, new BridgeInfo("V20", "test"));
        var reply = JsonDocument.Parse(dispatcher.Handle("{\"id\":1,\"method\":\"hmi.export\",\"params\":{\"device\":\"HMI_1\"}}")).RootElement;
        Assert.True(reply.TryGetProperty("result", out var result), reply.ToString());
        var items = result.GetProperty("items");
        Assert.Equal("tags", items[0].GetProperty("kind").GetString());
        Assert.Equal("Default tag table", items[0].GetProperty("name").GetString());
        Assert.StartsWith("<?xml", items[0].GetProperty("xml").GetString());
        foreach (var bad in new[] { "\"\"", "\"" + new string('x', 129) + "\"" })
        {
            var refused = JsonDocument.Parse(dispatcher.Handle("{\"id\":2,\"method\":\"hmi.export\",\"params\":{\"device\":" + bad + "}}")).RootElement;
            Assert.Equal(ErrorCodes.BadRequest, refused.GetProperty("error").GetProperty("code").GetString());
        }
    }
}
