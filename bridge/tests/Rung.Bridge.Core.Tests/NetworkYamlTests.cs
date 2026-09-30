// SPDX-License-Identifier: BUSL-1.1
using System.Linq;
using Rung.Bridge.Core;
using Xunit;

public class NetworkYamlTests
{
    static readonly InterfaceSettings[] Sample =
    {
        new InterfaceSettings { Key = "PLC_1 / PROFINET interface_1", Ip = "192.168.0.1", SubnetMask = "255.255.255.0", Router = "none", DeviceName = "auto", GeneratedName = "plc_1.profinet interface_1" },
        new InterfaceSettings { Key = "IO device_1 / PROFINET interface", Ip = "dhcp", Router = "192.168.0.254", DeviceName = "Line \"A\" #2" },
        new InterfaceSettings { Key = "PLC_1 / PROFINET interface_2", Ip = "192.168.1.1", SubnetMask = "255.255.255.0", Router = "none" },
    };

    [Fact] public void RendersEveryInterfaceWithItsSettingsAndReadsThemBack()
    {
        var text = NetworkYaml.Render("PLC_1", Sample);
        Assert.Contains("\n\"PLC_1 / PROFINET interface_1\":\n  ip: 192.168.0.1\n  subnetMask: 255.255.255.0\n  router: none\n  deviceName: auto  # plc_1.profinet interface_1\n", text);
        Assert.Contains("  deviceName: \"Line \\\"A\\\" #2\"\n", text);
        var back = NetworkYaml.Parse(text);
        Assert.Equal(Sample.Select(s => s.Key), back.Select(s => s.Key));
        Assert.Equal("auto", back[0].DeviceName);
        Assert.Equal("Line \"A\" #2", back[1].DeviceName);
        Assert.Null(back[1].SubnetMask);
        Assert.Null(back[2].DeviceName);
        Assert.Equal(NetworkYaml.Render("PLC_1", back.Select(b => { b.GeneratedName = b.Key == Sample[0].Key ? Sample[0].GeneratedName : null; return b; })), text);
    }

    [Fact] public void ALeftOutSettingStaysAsItIs()
    {
        var back = NetworkYaml.Parse("\"PLC_1 / X1\":\n  ip: 10.0.0.5\n");
        Assert.Equal("10.0.0.5", back.Single().Ip);
        Assert.Null(back.Single().Router);
        Assert.Null(back.Single().DeviceName);
    }

    /// <summary>A byte order mark, CRLF, tabs and comments as editors and people write them read like the file rung writes.</summary>
    [Fact] public void ReadsTheFileAsEditorsWriteIt()
    {
        var canonical = NetworkYaml.Render("PLC_1", NetworkYaml.Parse("\"PLC_1 / X1\":\n  ip: 10.0.0.5\n  subnetMask: 255.255.255.0\n  deviceName: \"a: b\"\n"));
        var edited = NetworkYaml.Parse("\uFEFF# settings\r\n\"PLC_1 / X1\":\t# the PLC\r\n\tip:\t10.0.0.5\r\n\tsubnetMask: 255.255.255.0 # /24\r\n\tdeviceName:\t\"a: b\"\r\n");
        Assert.Equal(canonical, NetworkYaml.Render("PLC_1", edited));
    }

    /// <summary>Module names and device names with quotes, colons, # and backslashes come back as they were.</summary>
    [Fact] public void OddNamesRoundTrip()
    {
        var random = new System.Random(7);
        const string alphabet = "aZ09 _-./()\":#\\'{}[]&*!|>%@`,?ü→";
        string Word() => new string(Enumerable.Range(0, random.Next(1, 12)).Select(_ => alphabet[random.Next(alphabet.Length)]).ToArray());
        for (var round = 0; round < 500; round++)
        {
            var wrote = new[] { new InterfaceSettings { Key = Word(), DeviceName = Word() }, new InterfaceSettings { Key = Word() + "!", Ip = "10.0.0.1", Router = "none", DeviceName = "auto", GeneratedName = Word() } };
            var back = NetworkYaml.Parse(NetworkYaml.Render("PLC_1", wrote));
            Assert.Equal(wrote.Select(w => w.Key + "|" + w.DeviceName + "|" + w.Ip), back.Select(b => b.Key + "|" + b.DeviceName + "|" + b.Ip));
        }
    }

    /// <summary>Every choice TIA Portal names (its enumeration, first letter lowered) reads back from the file.</summary>
    [Fact] public void ReadsBackEveryChoiceItWrites()
    {
        var text = NetworkYaml.Render("PLC_1", new[] { new InterfaceSettings { Key = "A", Ip = "viaIoController" }, new InterfaceSettings { Key = "B", Ip = "dhcp_v2" }, new InterfaceSettings { Key = "C", Ip = "mode2" } });
        Assert.Equal(new[] { "viaIoController", "dhcp_v2", "mode2" }, NetworkYaml.Parse(text).Select(s => s.Ip));
    }

    [Theory]
    [InlineData("\"A\":\n  ip: 192.168.0.300\n", "line 2: ip \"192.168.0.300\" is not an IPv4 address such as 192.168.0.1, dhcp or other")]
    [InlineData("\"A\":\n  subnetMask: 255.0.255.0\n", "line 2: 255.0.255.0 is not a subnet mask (the ones must be contiguous, as in 255.255.255.0)")]
    [InlineData("\"A\":\n  router: somewhere\n", "line 2: router \"somewhere\" is not an IPv4 address or none")]
    [InlineData("\"A\":\n  gateway: 1.2.3.4\n", "line 2: unknown setting gateway (ip, subnetMask, router, deviceName)")]
    [InlineData("  ip: 1.2.3.4\n", "line 1: a setting outside an interface")]
    [InlineData("\"A\":\n  ip: 1.2.3.4\n  ip: 1.2.3.5\n", "line 3: ip is set twice")]
    [InlineData("\"A\":\n\"A\":\n", "line 2: \"A\" appears twice")]
    [InlineData("\"A\":\n  deviceName: \"open\n", "line 2: a quote is not closed")]
    [InlineData("\"A\":\n  ip:\n", "line 2: ip has no value")]
    public void RefusesWhatTiaPortalWouldNotTakeWithTheLine(string text, string message) =>
        Assert.Equal(message, Assert.Throws<NetworkFormatException>(() => NetworkYaml.Parse(text)).Message);
}
