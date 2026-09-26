// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class SmokeTests
{
    [Fact] public void ProtocolVersionIsOne() => Assert.Equal(1, RpcConstants.ProtocolVersion);
}

public class AddressFormatTests
{
    static readonly JsonElement V = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "address-vectors.json"))).RootElement;

    public static IEnumerable<object[]> ValidSegments() =>
        V.GetProperty("segments").GetProperty("valid").EnumerateArray().Select(p => new object[] { p[0].GetString(), p[1].GetString() });
    public static IEnumerable<object[]> InvalidEscaped() =>
        V.GetProperty("segments").GetProperty("invalidEscaped").EnumerateArray().Select(p => new object[] { p.GetString() });
    // System.Text.Json cannot materialize lone surrogates; LoneSurrogateRejected covers that vector.
    public static IEnumerable<object[]> InvalidRaw() =>
        V.GetProperty("segments").GetProperty("invalidRaw").EnumerateArray()
            .Where(p => p.GetRawText().IndexOf("\\ud8", StringComparison.OrdinalIgnoreCase) < 0)
            .Select(p => new object[] { p.GetString() });
    public static IEnumerable<object[]> Addresses() =>
        V.GetProperty("addresses").EnumerateArray().Select(a => new object[] { a.GetRawText() });
    public static IEnumerable<object[]> InvalidAddresses() =>
        V.GetProperty("invalidAddressStrings").EnumerateArray().Select(p => new object[] { p.GetString() });

    [Theory, MemberData(nameof(ValidSegments))]
    public void SegmentRoundTrip(string raw, string escaped)
    {
        Assert.Equal(escaped, AddressFormat.EscapeSegment(raw));
        Assert.Equal(raw, AddressFormat.UnescapeSegment(escaped));
    }

    [Theory, MemberData(nameof(InvalidEscaped))]
    public void RejectsNoncanonical(string s) => Assert.Throws<AddressException>(() => AddressFormat.UnescapeSegment(s));

    [Theory, MemberData(nameof(InvalidRaw))]
    public void RejectsBadRaw(string s) => Assert.Throws<AddressException>(() => AddressFormat.EscapeSegment(s));

    [Fact] public void LoneSurrogateRejected() =>
        Assert.Throws<AddressException>(() => AddressFormat.EscapeSegment(new string(new[] { '\uD800', 'x' })));

    [Theory, MemberData(nameof(Addresses))]
    public void AddressRoundTrip(string json)
    {
        var v = JsonDocument.Parse(json).RootElement;
        var a = v.GetProperty("address");
        var parts = new AddressParts
        {
            Device = a.GetProperty("device").GetString(),
            Unit = a.TryGetProperty("unit", out var u) ? u.GetString() : null,
            Kind = a.GetProperty("kind").GetString(),
            Groups = a.GetProperty("groups").EnumerateArray().Select(g => g.GetString()).ToArray(),
            Name = a.GetProperty("name").GetString(),
            Namespace = a.TryGetProperty("namespace", out var n) ? n.GetString() : null,
        };
        var s = v.GetProperty("string").GetString();
        Assert.Equal(s, AddressFormat.Format(parts));
        var back = AddressFormat.Parse(s);
        Assert.Equal(parts.Device, back.Device);
        Assert.Equal(parts.Unit, back.Unit);
        Assert.Equal(parts.Kind, back.Kind);
        Assert.Equal(parts.Groups, back.Groups);
        Assert.Equal(parts.Name, back.Name);
        Assert.Equal(parts.Namespace, back.Namespace);
    }

    [Theory, MemberData(nameof(InvalidAddresses))]
    public void RejectsInvalidAddress(string s) => Assert.Throws<AddressException>(() => AddressFormat.Parse(s));
}

public class DispatcherTests
{
    static JsonElement Call(string line, FakeTiaSession s = null) =>
        JsonDocument.Parse(new RpcDispatcher(() => s ?? new FakeTiaSession(), new BridgeInfo("V20", "0.1.0-test")).Handle(line)).RootElement;

    [Fact] public void Hello()
    {
        var r = Call("{\"id\":1,\"method\":\"bridge.hello\",\"params\":{}}");
        Assert.Equal(1, r.GetProperty("id").GetInt32());
        Assert.Equal(1, r.GetProperty("result").GetProperty("protocol").GetInt32());
        Assert.Equal("V20", r.GetProperty("result").GetProperty("tiaVersion").GetString());
    }

    [Fact] public void HelloDoesNotTouchSession()
    {
        var d = new RpcDispatcher(() => throw new InvalidOperationException("no portal yet"), new BridgeInfo("V20", "t"));
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"bridge.hello\"}")).RootElement;
        Assert.True(r.TryGetProperty("result", out _));
    }

    [Fact] public void ListObjects()
    {
        var r = Call("{\"id\":2,\"method\":\"objects.list\",\"params\":{\"device\":\"PLC_1\"}}");
        var first = r.GetProperty("result")[0];
        Assert.Equal("plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", first.GetProperty("address").GetString());
        Assert.Equal("SCL", first.GetProperty("language").GetString());
        Assert.False(first.TryGetProperty("namespace", out _)); // null fields omitted
    }

    [Fact] public void StringIdsAreEchoed() =>
        Assert.Equal("abc", Call("{\"id\":\"abc\",\"method\":\"bridge.hello\"}").GetProperty("id").GetString());

    [Fact] public void UnknownMethod() =>
        Assert.Equal("BAD_REQUEST", Call("{\"id\":3,\"method\":\"nope\",\"params\":{}}").GetProperty("error").GetProperty("code").GetString());

    [Fact] public void MissingParamIsBadRequest() =>
        Assert.Equal("BAD_REQUEST", Call("{\"id\":3,\"method\":\"objects.list\",\"params\":{}}").GetProperty("error").GetProperty("code").GetString());

    [Fact] public void WrongParamTypeIsBadRequest() =>
        Assert.Equal("BAD_REQUEST", Call("{\"id\":3,\"method\":\"objects.list\",\"params\":{\"device\":5}}").GetProperty("error").GetProperty("code").GetString());

    [Fact] public void MalformedJsonReturnsErrorWithNullId()
    {
        var r = Call("{not json");
        Assert.Equal(JsonValueKind.Null, r.GetProperty("id").ValueKind);
        Assert.Equal("BAD_REQUEST", r.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void OversizedFrameRejected()
    {
        var d = new RpcDispatcher(() => new FakeTiaSession(), new BridgeInfo("V20", "t"), maxLineLength: 100);
        var r = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"bridge.hello\",\"params\":{\"pad\":\"" + new string('x', 200) + "\"}}")).RootElement;
        Assert.Equal("BAD_REQUEST", r.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void SessionRpcExceptionMapsCode()
    {
        var r = Call("{\"id\":4,\"method\":\"project.info\",\"params\":{}}", new FakeTiaSession { ThrowOnInfo = new RpcException(ErrorCodes.TiaNotRunning, "no portal") });
        Assert.Equal("TIA_NOT_RUNNING", r.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void UnexpectedExceptionMapsInternal()
    {
        var r = Call("{\"id\":5,\"method\":\"project.info\",\"params\":{}}", new FakeTiaSession { ThrowOnInfo = new InvalidOperationException("boom") });
        Assert.Equal("INTERNAL", r.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("boom", r.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact] public void SessionFactoryFailureIsReported()
    {
        var d = new RpcDispatcher(() => throw new RpcException(ErrorCodes.AccessDenied, "not in group"), new BridgeInfo("V20", "t"));
        var r = JsonDocument.Parse(d.Handle("{\"id\":6,\"method\":\"project.info\"}")).RootElement;
        Assert.Equal("ACCESS_DENIED", r.GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void ExportReturnsBundle()
    {
        var dir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-" + Guid.NewGuid().ToString("N"))).FullName;
        var r = Call("{\"id\":7,\"method\":\"objects.export\",\"params\":{\"address\":\"plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor\",\"form\":\"auto\",\"dir\":" + JsonSerializer.Serialize(dir) + "}}");
        var res = r.GetProperty("result");
        Assert.Equal("scl", res.GetProperty("form").GetString());
        var f = res.GetProperty("files")[0];
        Assert.Equal("primary", f.GetProperty("role").GetString());
        Assert.True(File.Exists(f.GetProperty("path").GetString()));
        Assert.Equal(64, res.GetProperty("bundleHash").GetString().Length);
    }

    [Fact] public void ImportIsRoutedAndValidated()
    {
        Assert.Equal("BAD_REQUEST", Call("{\"id\":8,\"method\":\"objects.import\",\"params\":{\"address\":\"plc:PLC_1/blocks/X\",\"form\":\"scl\",\"path\":\"C:/x.scl\"}}").GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("UNSUPPORTED_CAPABILITY", Call("{\"id\":9,\"method\":\"objects.import\",\"params\":{\"address\":\"plc:PLC_1/blocks/X\",\"form\":\"scl\",\"path\":\"C:/x.scl\",\"expectedTiaRevision\":\"fp:1\",\"operationId\":\"op\"}}").GetProperty("error").GetProperty("code").GetString());
    }

    [Fact] public void NonAsciiSurvivesTheWire()
    {
        var s = new FakeTiaSession();
        s.Objects[0].Address = "plc:PLC_1/blocks/Überwachung";
        Assert.Equal("plc:PLC_1/blocks/Überwachung", Call("{\"id\":1,\"method\":\"objects.list\",\"params\":{\"device\":\"PLC_1\"}}", s).GetProperty("result")[0].GetProperty("address").GetString());
    }
}

public class StdioHostTests
{
    [Fact] public void AnswersEachLineInOrderAndSkipsBlankLines()
    {
        var input = new StringReader("{\"id\":1,\"method\":\"bridge.hello\"}\n\n{\"id\":2,\"method\":\"nope\"}\n");
        var output = new StringWriter { NewLine = "\n" };
        using (var owner = new OwnerThread())
            new StdioHost(input, output).Run(new RpcDispatcher(() => new FakeTiaSession(), new BridgeInfo("V20", "t")), owner);
        var lines = output.ToString().TrimEnd('\n').Split('\n');
        Assert.Equal(2, lines.Length);
        Assert.Equal(1, JsonDocument.Parse(lines[0]).RootElement.GetProperty("id").GetInt32());
        Assert.Equal("BAD_REQUEST", JsonDocument.Parse(lines[1]).RootElement.GetProperty("error").GetProperty("code").GetString());
    }
}

public class BundleHashTests
{
    [Fact] public void IndependentOfOrderAndPath()
    {
        var a = Bundle.Hash(new[] { new ExportFile { Path = "/t/1/x.s7dcl", Role = "primary", Sha256 = "aa" }, new ExportFile { Path = "/t/1/x.s7res", Role = "res:en-US", Sha256 = "bb" } });
        var b = Bundle.Hash(new[] { new ExportFile { Path = "/q/x.s7res", Role = "res:en-US", Sha256 = "bb" }, new ExportFile { Path = "/q/x.s7dcl", Role = "primary", Sha256 = "aa" } });
        Assert.Equal(a, b);
        var c = Bundle.Hash(new[] { new ExportFile { Role = "primary", Sha256 = "ab" } });
        Assert.NotEqual(a, c);
    }
}

public class OwnerThreadTests
{
    [Fact] public void RunsAllJobsOnOneThreadInOrder()
    {
        using (var owner = new OwnerThread())
        {
            var ids = new System.Collections.Concurrent.ConcurrentBag<int>();
            var order = new List<int>();
            var tasks = Enumerable.Range(0, 50).Select(i => owner.Run(() => { ids.Add(Environment.CurrentManagedThreadId); lock (order) order.Add(i); return i; })).ToArray();
            System.Threading.Tasks.Task.WaitAll(tasks);
            Assert.Single(ids.Distinct());
            Assert.NotEqual(Environment.CurrentManagedThreadId, ids.First());
            Assert.Equal(Enumerable.Range(0, 50), order);
        }
    }

    [Fact] public void PropagatesExceptions()
    {
        using (var owner = new OwnerThread())
        {
            var ex = Assert.Throws<AggregateException>(() => owner.Run<int>(() => throw new RpcException(ErrorCodes.NotFound, "x")).Wait());
            Assert.IsType<RpcException>(ex.InnerException);
        }
    }

    [Fact] public void RejectsWorkAfterDispose()
    {
        var owner = new OwnerThread();
        owner.Dispose();
        Exception caught = null;
        try { owner.Run(() => 1); } catch (Exception e) { caught = e; }
        Assert.IsType<ObjectDisposedException>(caught);
    }
}

public class PortalSelectorTests
{
    static PortalCandidate[] P(params (int pid, string path)[] p) => p.Select(x => new PortalCandidate(x.pid, x.path)).ToArray();

    [Fact] public void NoneIsNotRunning() =>
        Assert.Equal("TIA_NOT_RUNNING", Assert.Throws<RpcException>(() => PortalSelector.Choose(P(), null)).Code);
    [Fact] public void SingleMatchByPath() =>
        Assert.Equal(7, PortalSelector.Choose(P((7, @"C:\p\A.ap20"), (8, @"C:\p\B.ap20")), @"c:\P\a.ap20").Pid);
    [Fact] public void MatchIgnoresSlashStyleAndTrailingSeparator() =>
        Assert.Equal(7, PortalSelector.Choose(P((7, @"C:\p\A.ap20")), "C:/p/A.ap20").Pid);
    [Fact] public void WantedPathNotOpenIsNoProject() =>
        Assert.Equal("NO_PROJECT", Assert.Throws<RpcException>(() => PortalSelector.Choose(P((7, @"C:\p\A.ap20")), @"C:\p\Other.ap20")).Code);
    [Fact] public void TwoMatchesAreAmbiguous() =>
        Assert.Equal("AMBIGUOUS_PORTAL", Assert.Throws<RpcException>(() => PortalSelector.Choose(P((7, @"C:\p\A.ap20"), (8, @"C:\p\A.ap20")), @"C:\p\A.ap20")).Code);
    [Fact] public void NoPathAndOneProjectPicksIt() =>
        Assert.Equal(8, PortalSelector.Choose(P((7, null), (8, @"C:\p\B.ap20")), null).Pid);
    [Fact] public void NoPathAndTwoProjectsIsAmbiguous() =>
        Assert.Equal("AMBIGUOUS_PORTAL", Assert.Throws<RpcException>(() => PortalSelector.Choose(P((7, @"C:\p\A.ap20"), (8, @"C:\p\B.ap20")), null)).Code);
    [Fact] public void RelativeWantedPathIsExpanded()
    {
        var abs = System.IO.Path.GetFullPath("fx.ap20");
        Assert.Equal(7, PortalSelector.Choose(P((7, abs)), "fx.ap20").Pid);
    }
    [Fact] public void NoProjectAnywhere() =>
        Assert.Equal("NO_PROJECT", Assert.Throws<RpcException>(() => PortalSelector.Choose(P((7, null)), null)).Code);
}

public class FormPolicyTests
{
    [Theory]
    [InlineData("block", "SCL", "FB", false, false, "scl")]
    [InlineData("block", "SCL", "OB", false, false, "scl")]
    [InlineData("block", "LAD", "FC", false, false, "s7dcl")]
    [InlineData("block", "FBD", "FC", false, false, "xml")]
    [InlineData("block", "GRAPH", "FB", false, false, "xml")]
    [InlineData("block", "STL", "FC", false, false, "awl")]
    [InlineData("block", "SCL", "FB", true, false, "protected.yaml")]
    [InlineData("block", "DB", "GlobalDB", false, false, "db")]
    [InlineData("block", "DB", "InstanceDB", false, false, "db")]
    [InlineData("block", "DB", "GlobalDB", false, true, "xml")]
    [InlineData("block", "F_SCL", "FB", false, true, "scl")]
    [InlineData("type", null, null, false, false, "udt")]
    [InlineData("type", null, null, false, true, "xml")]
    [InlineData("type", null, null, true, false, "protected.yaml")]
    [InlineData("tagtable", null, null, false, false, "tags.xml")]
    [InlineData("watchtable", null, null, false, false, "xml")]
    public void Chooses(string kind, string lang, string bt, bool khp, bool fs, string expected) =>
        Assert.Equal(expected, FormPolicy.Choose(new ObjectEntry { Kind = kind, Language = lang, BlockType = bt, KnowHowProtected = khp, IsFailsafe = fs }, new FormCapabilities { SdLad = true }));

    [Fact] public void LadFallsBackToXmlWithoutSd() =>
        Assert.Equal("xml", FormPolicy.Choose(new ObjectEntry { Kind = "block", Language = "LAD", BlockType = "FC" }, new FormCapabilities { SdLad = false }));

    [Fact] public void StlKillSwitch() =>
        Assert.Equal("xml", FormPolicy.Choose(new ObjectEntry { Kind = "block", Language = "STL", BlockType = "FC" }, new FormCapabilities { SourceStl = false }));

    [Theory]
    [InlineData(false, false, false, "SCL", false)]
    [InlineData(true, false, false, "SCL", true)]
    [InlineData(false, true, false, "SCL", true)]
    [InlineData(false, false, true, "SCL", true)]
    [InlineData(false, false, false, "GRAPH", true)]
    public void ReadOnlyRules(bool khp, bool fs, bool sys, string lang, bool expected) =>
        Assert.Equal(expected, FormPolicy.IsReadOnly(new ObjectEntry { Kind = "block", Language = lang, KnowHowProtected = khp, IsFailsafe = fs, IsSystem = sys }));
}

public class CompileRouteTests
{
    static JsonElement Call(string line) => JsonDocument.Parse(new RpcDispatcher(() => new FakeTiaSession(), new BridgeInfo("V20", "t")).Handle(line)).RootElement;
    [Fact] public void CompileFlattensMessages()
    {
        var r = Call("{\"id\":1,\"method\":\"plc.compile\",\"params\":{\"device\":\"PLC_1\",\"addresses\":[\"plc:PLC_1/blocks/Fx_Broken\"]}}").GetProperty("result")[0];
        Assert.Equal("error", r.GetProperty("severity").GetString());
        Assert.Equal("plc:PLC_1/blocks/Fx_Broken", r.GetProperty("address").GetString());
    }
    [Fact] public void AddressesMustBeStrings() =>
        Assert.Equal("BAD_REQUEST", Call("{\"id\":1,\"method\":\"plc.compile\",\"params\":{\"device\":\"PLC_1\",\"addresses\":[1]}}").GetProperty("error").GetProperty("code").GetString());
    [Fact] public void AddressesOptional() =>
        Assert.True(Call("{\"id\":1,\"method\":\"plc.compile\",\"params\":{\"device\":\"PLC_1\"}}").TryGetProperty("result", out _));
}

public class DeleteRouteTests
{
    [Fact] public void DeleteChecksRevision()
    {
        var s = new FakeTiaSession();
        var d = new RpcDispatcher(() => s, new BridgeInfo("V20", "t"));
        var stale = JsonDocument.Parse(d.Handle("{\"id\":1,\"method\":\"objects.delete\",\"params\":{\"address\":\"plc:PLC_1/types/Fx_Types\",\"expectedTiaRevision\":\"dt:0\",\"operationId\":\"x\"}}")).RootElement;
        Assert.Equal("STALE_REVISION", stale.GetProperty("error").GetProperty("code").GetString());
        var ok = JsonDocument.Parse(d.Handle("{\"id\":2,\"method\":\"objects.delete\",\"params\":{\"address\":\"plc:PLC_1/types/Fx_Types\",\"expectedTiaRevision\":\"dt:1:2\",\"operationId\":\"x\"}}")).RootElement;
        Assert.True(ok.GetProperty("result").GetProperty("deleted").GetBoolean());
        Assert.Single(s.Objects);
    }
}
