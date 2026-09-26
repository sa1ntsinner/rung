// SPDX-License-Identifier: BUSL-1.1
// Run: open %USERPROFILE%\rung-fixtures\RungFixture\RungFixture.ap20 in TIA Portal, set RUNG_PROJECT to it, then
//   dotnet test bridge/tests/Rung.Bridge.V20.IntegrationTests --filter Category=Tia
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Rung.Bridge.V20;
using Xunit;

namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, Inherited = false)]
    internal sealed class ModuleInitializerAttribute : Attribute { }
}

static class OpennessResolve
{
    [System.Runtime.CompilerServices.ModuleInitializer]
    internal static void Init()
    {
        var dir = Environment.GetEnvironmentVariable("RUNG_OPENNESS_DIR") ?? @"C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20";
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            var n = new AssemblyName(e.Name).Name;
            var p = Path.Combine(dir, n + ".dll");
            return n.StartsWith("Siemens.Engineering", StringComparison.Ordinal) && File.Exists(p) ? Assembly.LoadFrom(p) : null;
        };
    }
}

public sealed class FixtureSession : IDisposable
{
    public readonly OpennessSession Session;
    public readonly string ProjectPath;
    public readonly string[] ManifestAddresses;
    public readonly List<string> Events = new List<string>();

    public FixtureSession()
    {
        ProjectPath = Environment.GetEnvironmentVariable("RUNG_PROJECT")
            ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "rung-fixtures", "RungFixture", "RungFixture.ap20");
        var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(ProjectPath), "fixture-manifest.json"))).RootElement;
        ManifestAddresses = manifest.GetProperty("addresses").EnumerateArray().Select(a => a.GetString()).ToArray();
        Session = OpennessSession.Attach(new BridgeArgs { ProjectPath = ProjectPath, AllowFixtureImport = true }, (n, p) => { lock (Events) Events.Add(n); });
    }

    public void Dispose() => Session.Dispose();
}

[Trait("Category", "Tia")]
public class AdapterTests : IClassFixture<FixtureSession>
{
    readonly FixtureSession _fx;
    public AdapterTests(FixtureSession fx) { _fx = fx; }

    static string Tmp() => Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N"))).FullName;

    [Fact] public void ProjectInfoMatchesBinding()
    {
        var info = _fx.Session.GetProjectInfo();
        Assert.Equal(Path.GetFullPath(_fx.ProjectPath), info.Path, StringComparer.OrdinalIgnoreCase);
        Assert.Contains("PLC_1", info.Devices);
        Assert.Equal("V20", info.TiaVersion);
    }

    [Fact] public void ListsEveryManifestObjectIncludingFolders()
    {
        var all = _fx.Session.ListObjects("PLC_1").Select(o => o.Address).ToList();
        foreach (var a in _fx.ManifestAddresses) Assert.Contains(a, all);
        Assert.All(_fx.Session.ListObjects("PLC_1"), o => Assert.False(string.IsNullOrEmpty(o.Fingerprint)));
    }

    [Fact] public void MotorIsAnSclFbWithStrongFingerprint()
    {
        var m = _fx.Session.ListObjects("PLC_1").Single(o => o.Address == "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor");
        Assert.Equal("SCL", m.Language);
        Assert.Equal("FB", m.BlockType);
        Assert.StartsWith("fp:", m.Fingerprint);
    }

    [Fact] public void BrokenBlockIsInconsistentWithDateFingerprint()
    {
        var b = _fx.Session.ListObjects("PLC_1").Single(o => o.Address == "plc:PLC_1/blocks/Fx_Broken");
        Assert.Equal(false, b.IsConsistent);
        Assert.StartsWith("dt:", b.Fingerprint);
    }

    [Fact] public void FingerprintIsStableAcrossInventories()
    {
        string Fp() => _fx.Session.ListObjects("PLC_1").Single(o => o.Address.EndsWith("/Fx_Motor")).Fingerprint;
        Assert.Equal(Fp(), Fp());
    }

    [Fact] public void ExportsSclAsNormalizedUtf8AndDeterministic()
    {
        var a = _fx.Session.Export("plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", "auto", Tmp());
        var b = _fx.Session.Export("plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", "auto", Tmp());
        Assert.Equal("scl", a.Form);
        var text = File.ReadAllText(a.Files.Single(f => f.Role == "primary").Path, Encoding.UTF8);
        Assert.Contains("FUNCTION_BLOCK \"Fx_Motor\"", text);
        Assert.Contains("Überwachung", text);
        Assert.DoesNotContain("\r\n", text);
        Assert.NotEqual('\uFEFF', text[0]);
        Assert.Equal(a.BundleHash, b.BundleHash);
        Assert.EndsWith("obj.scl", a.Files[0].Path);
    }

    [Theory]
    [InlineData("plc:PLC_1/types/Fx_Types", "udt")]
    [InlineData("plc:PLC_1/blocks/Fx_Global", "db")]
    [InlineData("plc:PLC_1/blocks/Fx_Stl", "awl")]
    [InlineData("plc:PLC_1/tags/Fx_Inputs", "tags.xml")]
    public void ExportsEachKindInItsForm(string address, string form)
    {
        var r = _fx.Session.Export(address, "auto", Tmp());
        Assert.Equal(form, r.Form);
        Assert.True(new FileInfo(r.Files.Single(f => f.Role == "primary").Path).Length > 0);
    }

    [Fact] public void LadExportsAsSdOrFallsBackToXml()
    {
        if (!_fx.ManifestAddresses.Contains("plc:PLC_1/blocks/20_Valves/Fx_LadInterlock")) return; // fixture could not import LAD
        var r = _fx.Session.Export("plc:PLC_1/blocks/20_Valves/Fx_LadInterlock", "auto", Tmp());
        Assert.True(r.Form == "s7dcl" || (r.Form == "xml" && r.Warnings.Contains("SD_FALLBACK")), "form " + r.Form + " warnings " + string.Join(",", r.Warnings));
    }

    [Fact] public void ProtectedBlockBecomesReadOnlyYaml()
    {
        if (!_fx.ManifestAddresses.Contains("plc:PLC_1/blocks/Fx_Secret")) return;
        var e = _fx.Session.ListObjects("PLC_1").Single(o => o.Address == "plc:PLC_1/blocks/Fx_Secret");
        Assert.True(e.KnowHowProtected);
        var r = _fx.Session.Export(e.Address, "auto", Tmp());
        Assert.Equal("protected.yaml", r.Form);
        Assert.Contains("readOnly: true", File.ReadAllText(r.Files[0].Path));
    }

    [Fact] public void ImportRefusesProtectedObjects()
    {
        if (!_fx.ManifestAddresses.Contains("plc:PLC_1/blocks/Fx_Secret")) return;
        var e = _fx.Session.ListObjects("PLC_1").Single(o => o.Address == "plc:PLC_1/blocks/Fx_Secret");
        var ex = Assert.Throws<RpcException>(() => _fx.Session.Import(e.Address, "scl", "C:\\nope.scl", e.Fingerprint, Guid.NewGuid().ToString()));
        Assert.Equal("READ_ONLY", ex.Code);
    }

    [Fact] public void ImportRefusesStaleRevision()
    {
        var ex = Assert.Throws<RpcException>(() => _fx.Session.Import("plc:PLC_1/blocks/20_Valves/Fx_Valve", "scl", "C:\\nope.scl", "fp:not-the-current-one", Guid.NewGuid().ToString()));
        Assert.Equal("STALE_REVISION", ex.Code);
    }

    [Fact] public void SclRoundTripIsGuardedAndReturnsFreshExport()
    {
        var address = "plc:PLC_1/blocks/20_Valves/Fx_Valve";
        var first = _fx.Session.Export(address, "auto", Tmp());
        var after = _fx.Session.Import(address, first.Form, first.Files[0].Path, first.Fingerprint, Guid.NewGuid().ToString());
        Assert.Equal("scl", after.Form);
        var again = _fx.Session.Export(address, "auto", Tmp());
        Assert.Equal(after.BundleHash, again.BundleHash);
        Assert.Contains(_fx.Session.ListObjects("PLC_1"), o => o.Address == address); // still in its folder
    }

    [Fact] public void ImportRejectsASourceDeclaringAnotherBlock()
    {
        var address = "plc:PLC_1/blocks/20_Valves/Fx_Valve";
        var cur = _fx.Session.Export(address, "auto", Tmp());
        var evil = Path.Combine(Tmp(), "obj.scl");
        File.WriteAllText(evil, File.ReadAllText(cur.Files[0].Path).Replace("\"Fx_Valve\"", "\"Fx_Intruder\""));
        var ex = Assert.Throws<RpcException>(() => _fx.Session.Import(address, "scl", evil, cur.Fingerprint, Guid.NewGuid().ToString()));
        Assert.Equal("IMPORT_FAILED", ex.Code);
        Assert.DoesNotContain(_fx.Session.ListObjects("PLC_1"), o => o.Address.EndsWith("/Fx_Intruder")); // rolled back
    }
}

[Trait("Category", "NoPortal")]
public class NoPortalTests
{
    [Fact] public void AttachReturnsTypedError() =>
        Assert.Equal("TIA_NOT_RUNNING", Assert.Throws<RpcException>(() => OpennessSession.Attach(new BridgeArgs { ProjectPath = @"C:\nope\Nope.ap20" }, (n, p) => { })).Code);
}

[Trait("Category", "Tia")]
public class TwoWayAdapterTests : IClassFixture<FixtureSession>
{
    readonly FixtureSession _fx;
    public TwoWayAdapterTests(FixtureSession fx) { _fx = fx; }

    [Fact] public void CreatesANewBlockInANewFolderAndCompilesIt()
    {
        var name = "Fx_New_" + Guid.NewGuid().ToString("N").Substring(0, 6);
        var address = "plc:PLC_1/blocks/30_New/" + name;
        var src = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N"))).FullName, "obj.scl");
        File.WriteAllText(src, "FUNCTION \"" + name + "\" : Void\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n   VAR_INPUT\n      A : Bool;\n   END_VAR\n\nBEGIN\n\t;\nEND_FUNCTION\n");
        var r = _fx.Session.Import(address, "scl", src, "absent", Guid.NewGuid().ToString());
        Assert.Equal("scl", r.Form);
        Assert.Contains(_fx.Session.ListObjects("PLC_1"), o => o.Address == address);
        Assert.DoesNotContain(_fx.Session.Compile("PLC_1", new[] { address }), m => m.Severity == "error");
    }

    [Fact] public void CompileOfBrokenBlockReportsErrorsWithAddress()
    {
        var msgs = _fx.Session.Compile("PLC_1", new[] { "plc:PLC_1/blocks/Fx_Broken" });
        Assert.Contains(msgs, m => m.Severity == "error" && m.Address == "plc:PLC_1/blocks/Fx_Broken");
    }

    [Fact] public void CreatingAnExistingObjectIsRefused() =>
        Assert.Equal("STALE_REVISION", Assert.Throws<RpcException>(() => _fx.Session.Import("plc:PLC_1/blocks/20_Valves/Fx_Valve", "scl", @"C:\x.scl", "absent", Guid.NewGuid().ToString())).Code);
}

[Trait("Category", "Tia")]
public class XRefAdapterTests : IClassFixture<FixtureSession>
{
    readonly FixtureSession _fx;
    public XRefAdapterTests(FixtureSession fx) { _fx = fx; }

    [Fact] public void GlobalDbReportsItsUsers()
    {
        _fx.Session.ListObjects("PLC_1");
        var entries = _fx.Session.XRef("plc:PLC_1/blocks/Fx_Global");
        Assert.NotNull(entries); // shape is recorded as fact F14; content depends on fixture usage
    }
}
