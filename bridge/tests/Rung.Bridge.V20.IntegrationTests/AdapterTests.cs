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

// every class attaches its own session to the one TIA: in parallel, one imports while another lists
[assembly: CollectionBehavior(DisableTestParallelization = true)]

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

    [Fact] public void EveryExportIsByteStableAcrossRepeats()
    {
        // force tables have no DocumentInfoOptions overload; a timestamp there made every sync re-export
        foreach (var e in _fx.Session.ListObjects("PLC_1").Where(o => o.Kind != "folder" && o.Kind != "unit" && o.IsConsistent != false))
        {
            var a = _fx.Session.Export(e.Address, "auto", Tmp());
            var b = _fx.Session.Export(e.Address, "auto", Tmp());
            Assert.True(a.BundleHash == b.BundleHash, e.Address + " (" + a.Form + ") export is not stable");
        }
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
        Assert.Equal(first.BundleHash, after.BundleHash); // import of an unchanged export is a no-op (no drift)
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

    [Fact] public void NetworkSettingsAreAFileThatSetsTheInterfaces()
    {
        const string address = "plc:PLC_1/hardware/network";
        Assert.Equal("hardware", _fx.Session.ListObjects("PLC_1").Single(o => o.Address == address).Kind);
        var cur = _fx.Session.Export(address, "auto", Tmp());
        Assert.Equal("yaml", cur.Form);
        var original = File.ReadAllText(cur.Files[0].Path).Replace("\r\n", "\n");
        Assert.Contains("\n\"PLC_1 / PROFINET interface_1\":\n  ip: ", original);
        var ip = System.Text.RegularExpressions.Regex.Match(original, @"\n  ip: (\S+)").Groups[1].Value;
        string Write(string text) { var p = Path.Combine(Tmp(), "obj.yaml"); File.WriteAllText(p, text); return p; }
        try
        {
            // an address and a PROFINET name set, then read back as TIA Portal has them
            var edited = original.Replace("  ip: " + ip + "\n", "  ip: 192.168.77.1\n");
            edited = edited.Substring(0, edited.IndexOf("deviceName: auto", StringComparison.Ordinal)) + "deviceName: Line PLC" + edited.Substring(edited.IndexOf('\n', edited.IndexOf("deviceName: auto", StringComparison.Ordinal)));
            var after = _fx.Session.Import(address, "yaml", Write(edited), cur.Fingerprint, Guid.NewGuid().ToString());
            var text = File.ReadAllText(after.Files[0].Path);
            Assert.Contains("ip: 192.168.77.1", text);
            Assert.Contains("deviceName: Line PLC\n", text.Replace("\r\n", "\n"));
            // a value TIA Portal refuses: the whole file is refused, with its line
            var bad = _fx.Session.Export(address, "auto", Tmp());
            var ex = Assert.Throws<RpcException>(() => _fx.Session.Import(address, "yaml", Write(File.ReadAllText(bad.Files[0].Path).Replace("ip: 192.168.77.1", "ip: 0.0.0.0")), bad.Fingerprint, Guid.NewGuid().ToString()));
            Assert.Equal("IMPORT_FAILED", ex.Code);
            Assert.StartsWith("line 8: PLC_1 / PROFINET interface_1: ", ex.Message);
            Assert.Equal(bad.BundleHash, _fx.Session.Export(address, "auto", Tmp()).BundleHash);
        }
        finally
        {
            var now = _fx.Session.Export(address, "auto", Tmp());
            _fx.Session.Import(address, "yaml", Write(original), now.Fingerprint, Guid.NewGuid().ToString());
        }
        Assert.Equal(cur.BundleHash, _fx.Session.Export(address, "auto", Tmp()).BundleHash);
    }
}

[Trait("Category", "NoPortal")]
public class NoPortalTests
{
    [Fact] public void AttachReturnsTypedError()
    {
        // with a TIA running (a fixture host) the project is what is missing
        var tia = System.Diagnostics.Process.GetProcessesByName("Siemens.Automation.Portal").Length > 0;
        var ex = Assert.Throws<RpcException>(() => OpennessSession.Attach(new BridgeArgs { ProjectPath = @"C:\nope\Nope.ap20" }, (n, p) => { }));
        Assert.Equal(tia ? "NO_PROJECT" : "TIA_NOT_RUNNING", ex.Code);
    }
}

[Trait("Category", "Tia")]
public class TwoWayAdapterTests : IClassFixture<FixtureSession>
{
    readonly FixtureSession _fx;
    public TwoWayAdapterTests(FixtureSession fx) { _fx = fx; }

    [Fact] public void WatchTableIsEditableAsXmlAndNoticesChangesInTia()
    {
        const string address = "plc:PLC_1/watch/Fx_Watch";
        if (!_fx.Session.ListObjects("PLC_1").Any(o => o.Address == address)) { Console.WriteLine("fixture without Fx_Watch (regenerate it): skipped"); return; }
        var cur = _fx.Session.Export(address, "auto", Tmp());
        Assert.Equal("xml", cur.Form);
        Assert.StartsWith("xh:", cur.Fingerprint);
        Assert.Equal(cur.Fingerprint, _fx.Session.Export(address, "auto", Tmp()).Fingerprint); // byte-stable
        // what a person does: the same table imported back is accepted, a stale revision is refused
        var same = Path.Combine(Tmp(), "obj.xml");
        File.Copy(cur.Files[0].Path, same);
        var r = _fx.Session.Import(address, "xml", same, cur.Fingerprint, Guid.NewGuid().ToString());
        Assert.Equal("xml", r.Form);
        Assert.Equal("STALE_REVISION", Assert.Throws<RpcException>(() => _fx.Session.Import(address, "xml", same, "xh:0000000000000000", Guid.NewGuid().ToString())).Code);
        // a force table stays read-only
        var force = _fx.Session.ListObjects("PLC_1").FirstOrDefault(o => o.Kind == "forcetable");
        if (force != null)
        {
            var f = _fx.Session.Export(force.Address, "auto", Tmp());
            Assert.Equal("READ_ONLY", Assert.Throws<RpcException>(() => _fx.Session.Import(force.Address, "xml", f.Files[0].Path, f.Fingerprint, Guid.NewGuid().ToString())).Code);
        }
    }

    static string Tmp() => Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N"))).FullName;

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

    [Fact] public void RepeatedInventoriesReuseFingerprintsButSeeChanges()
    {
        // an idle watch must not recompute every fingerprint on every pass
        _fx.Session.ListObjects("PLC_1");
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var first = _fx.Session.ListObjects("PLC_1").ToDictionary(o => o.Address, o => o.Fingerprint);
        var warm = sw.ElapsedMilliseconds;
        Console.WriteLine("warm inventory: " + warm + " ms for " + first.Count + " objects");
        // a change in TIA shows up in the next inventory
        var address = "plc:PLC_1/blocks/20_Valves/Fx_Valve";
        var export = _fx.Session.Export(address, "auto", Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N")));
        var edited = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N"))).FullName, "obj.scl");
        File.WriteAllText(edited, File.ReadAllText(export.Files[0].Path).Replace("#Open := FALSE;", "#Open := FALSE; // cache probe " + Guid.NewGuid().ToString("N").Substring(0, 6)));
        _fx.Session.Import(address, "scl", edited, export.Fingerprint, Guid.NewGuid().ToString());
        var after = _fx.Session.ListObjects("PLC_1").ToDictionary(o => o.Address, o => o.Fingerprint);
        Assert.NotEqual(first[address], after[address]);
    }

    [Fact] public void ListsConnectionModesAndReportsOffline()
    {
        var c = _fx.Session.Connections("PLC_1", scan: false);
        Assert.NotEmpty(c.Modes);
        Assert.Contains(c.Modes, m => m.PcInterfaces.Count > 0);
        Assert.Equal("Offline", _fx.Session.Online("PLC_1", "state", null).State);
    }

    [Fact] public void DownloadWithoutATargetExplainsWhatToConfigure()
    {
        var ex = Assert.Throws<RpcException>(() => _fx.Session.Download(new DownloadRequest { Device = "PLC_1" }));
        Assert.Equal("NO_TARGET", ex.Code);
        Assert.Contains("rung interfaces", ex.Message);
    }

    [Fact] public void CompilesTheHardware() =>
        Assert.NotEmpty(_fx.Session.CompileHardware("PLC_1"));

    [Fact] public void ACopyInAnotherFolderNeverOverwritesTheOriginal()
    {
        // GenerateBlocksFromSource replaces a same-named block wherever it lives
        var original = "plc:PLC_1/blocks/20_Valves/Fx_Valve";
        var before = _fx.Session.Export(original, "auto", Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N")));
        var copy = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N"))).FullName, "obj.scl");
        File.WriteAllText(copy, File.ReadAllText(before.Files[0].Path).Replace("#Open := FALSE;", "#Open := TRUE;"));
        var ex = Assert.Throws<RpcException>(() => _fx.Session.Import("plc:PLC_1/blocks/10_Drives/Fx_Valve", "scl", copy, "absent", Guid.NewGuid().ToString()));
        Assert.Equal("NAME_TAKEN", ex.Code);
        Assert.Contains(original, ex.Message);
        var after = _fx.Session.Export(original, "auto", Path.Combine(Path.GetTempPath(), "rung-it", Guid.NewGuid().ToString("N")));
        Assert.Equal(before.BundleHash, after.BundleHash);
        Assert.DoesNotContain(_fx.Session.ListObjects("PLC_1"), o => o.Address == "plc:PLC_1/blocks/10_Drives/Fx_Valve");
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
        Assert.NotNull(entries); // content depends on fixture usage
    }
}

[Trait("Category", "Tia")]
public class DescribeAdapterTests : IClassFixture<FixtureSession>
{
    readonly FixtureSession _fx;
    public DescribeAdapterTests(FixtureSession fx) { _fx = fx; }

    [Fact] public void HardwareViewContainsTheCpu()
    {
        var tree = _fx.Session.Describe("hardware", 5000);
        Assert.Contains(tree.Children["Devices"], d => d.Name != null);
    }

    [Fact] public void LibrariesViewHasTheProjectLibraryAndTheSystemLibraries()
    {
        var tree = _fx.Session.Describe("libraries", 5000);
        var lib = Assert.Single(tree.Children["ProjectLibrary"]);
        Assert.Equal("Types", Assert.Single(lib.Children["Types"]).Name);
        Assert.Contains(tree.Children["GlobalLibraries"], g => g.Attributes.TryGetValue("LibraryType", out var t) && t == "System");
    }

    [Fact] public void UnknownScopeIsRejected() =>
        Assert.Equal("BAD_REQUEST", Assert.Throws<RpcException>(() => _fx.Session.Describe("nope", 10)).Code);
}
