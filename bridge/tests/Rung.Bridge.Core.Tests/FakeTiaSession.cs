// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

public sealed class FakeTiaSession : ITiaSession
{
    public bool SessionWindow, SessionModified, SessionSaveAfterImport, SessionClosed, SessionSaved;
    public bool SessionKeeper = true;
    public SessionState GetSessionState() => new SessionState { ProjectPath = GetProjectInfo().Path, TiaPid = 42, Mode = SessionWindow ? "ui" : "headless", HeldBy = SessionKeeper ? "keeper" : "other", AttachedSessions = 1 };
    public void ReleaseSession(bool save)
    {
        var step = SessionRelease.Decide(SessionWindow, SessionKeeper, SessionModified, save || SessionSaveAfterImport);
        if (step == WindowStep.Busy) throw new RpcException(ErrorCodes.ProjectBusy, "another program holds it");
        if (step == WindowStep.Unsaved) throw new RpcException(ErrorCodes.ProjectUnsaved, "unsaved changes");
        SessionSaved = step == WindowStep.SaveAndMove;
        SessionClosed = true;
    }
    public DownloadRequest LastDownload;
    public string OnlineState = "Offline";
    public IReadOnlyList<CompileMessage> CompileHardware(string device) => new[] { new CompileMessage { Severity = "info", Description = "hardware ok" } };
    public OnlineCredentialsInput LastCredentials;
    public ConnectionTarget LastOnlineTarget;
    public OnlineStatus Online(string device, string action, ConnectionTarget target, OnlineCredentialsInput credentials)
    {
        LastOnlineTarget = target;
        LastCredentials = credentials;
        if (action == "online") OnlineState = "Online";
        else if (action == "offline") OnlineState = "Offline";
        else if (action != "state") throw new RpcException(ErrorCodes.BadRequest, "action");
        return new OnlineStatus { Device = device, State = OnlineState };
    }
    public CompareOutcome Compare(string device, ConnectionTarget target, OnlineCredentialsInput credentials)
    {
        LastOnlineTarget = target;
        LastCredentials = credentials;
        return new CompareOutcome
        {
            Device = device,
            State = "FolderContentsDifferent",
            Identical = 3,
            Items = { new CompareItem { Path = "Program blocks/Fx_Motor", Name = "Fx_Motor", State = "Different", Address = "plc:PLC_1/blocks/Fx_Motor" } },
        };
    }
    public ConnectionOptions Connections(string device, bool scan) => new ConnectionOptions
    {
        Device = device,
        Modes = { new ConnectionModeInfo { Name = "PN/IE", PcInterfaces = { new PcInterfaceInfo { Name = "PLCSIM", Number = 1, TargetInterfaces = new[] { "1 X1" }, Subnets = new string[0] } } } },
    };
    public UploadRequest LastUpload;
    public UploadOutcome UploadStation(UploadRequest request)
    {
        LastUpload = request;
        return new UploadOutcome { State = "Success", Station = "S71500/ET200MP station_1", Plcs = new[] { "PLC_2" } };
    }

    public (string Dir, int Keep)? LastArchive;
    public ArchiveOutcome Archive(string directory, int keep)
    {
        LastArchive = (directory, keep);
        return new ArchiveOutcome { Path = (directory ?? "C:\\backups") + "\\Fx_20261002_120000.zap20", Bytes = 1234, Removed = new string[0] };
    }

    public DownloadOutcome Download(DownloadRequest request)
    {
        LastDownload = request;
        var d = DownloadPolicy.Decide("StopModules", new[] { "NoAction", "StopAll" }, request.Allow, request.StartAfter);
        var o = new DownloadOutcome { Device = request.Device, State = d.Blocks ? "Cancelled" : "Success" };
        o.Decisions.Add(new DownloadDecision { Phase = "pre", Kind = "StopModules", Name = d.Name, Choice = d.Choice, Allowed = d.Allowed, Blocks = d.Blocks });
        if (d.Blocks) o.NeedsAllow = new[] { d.Name };
        return o;
    }
    public bool? LastShowSave;
    public void Show(string address, bool save) { LastShowSave = save; throw new RpcException(ErrorCodes.UnsupportedCapability, "no UI"); }

    public Exception ThrowOnInfo;

    public readonly List<ObjectEntry> Objects = new List<ObjectEntry>
    {
        new ObjectEntry { Address = "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", Kind = "block", Language = "SCL", BlockType = "FB", Number = 1, IsConsistent = true, Fingerprint = "fp:Code=1" },
        new ObjectEntry { Address = "plc:PLC_1/types/Fx_Types", Kind = "type", IsConsistent = true, Fingerprint = "dt:1:2" },
    };

    public ProjectInfo GetProjectInfo()
    {
        if (ThrowOnInfo != null) throw ThrowOnInfo;
        return new ProjectInfo { Name = "RungFixture", Path = @"C:\fx\RungFixture\RungFixture.ap20", TiaVersion = "V20", Devices = new[] { "PLC_1" }, IsLocalSession = false, Units = new[] { "Fx_Unit" } };
    }

    public IReadOnlyDictionary<string, KnownRevision> Known;
    public IReadOnlyList<ObjectEntry> ListObjects(string device, IReadOnlyDictionary<string, KnownRevision> known = null)
    {
        Known = known;
        return Objects;
    }

    public ExportResult Export(string address, string form, string targetDir)
    {
        var entry = Objects.Find(o => o.Address == address) ?? throw new RpcException(ErrorCodes.NotFound, address);
        if (form == "auto") form = FormPolicy.Choose(entry, new FormCapabilities());
        var path = Path.Combine(targetDir, "obj." + form);
        var bytes = new UTF8Encoding(false).GetBytes("FUNCTION_BLOCK \"Fx_Motor\"\nEND_FUNCTION_BLOCK\n");
        File.WriteAllBytes(path, bytes);
        var files = new[] { new ExportFile { Path = path, Role = "primary", Sha256 = Bundle.Sha256(bytes) } };
        return new ExportResult { Address = address, Form = form, Files = files, Warnings = new string[0], Fingerprint = entry.Fingerprint, BundleHash = Bundle.Hash(files) };
    }

    public IReadOnlyList<CompileMessage> Compile(string device, string[] addresses) =>
        new[] { new CompileMessage { Address = addresses.Length > 0 ? addresses[0] : null, Severity = "error", Path = "PLC_1/Fx_Broken", Description = "Tag #Missing not defined" } };

    public DescribeNode Describe(string scope, int maxNodes) => new DescribeNode
    {
        Type = "Project", Name = "RungFixture",
        Attributes = new SortedDictionary<string, string>(),
        Children = new SortedDictionary<string, List<DescribeNode>>
        {
            ["Devices"] = new List<DescribeNode> { new DescribeNode { Type = "Device", Name = "PLC_1", Attributes = new SortedDictionary<string, string> { ["TypeIdentifier"] = "OrderNumber:6ES7 516-3AN02-0AB0/V3.1" }, Children = new SortedDictionary<string, List<DescribeNode>>() } },
        },
    };

    public IReadOnlyList<XRefEntry> XRef(string address) =>
        new[] { new XRefEntry { Source = address, SourceName = "Fx_Motor", TargetName = "Start_Button", TargetType = "Tag", TargetAddress = "%I0.0", Access = "Read", ReferenceType = "Uses", Location = "@Fx_Motor NW1" } };

    public IReadOnlyDictionary<string, string> Identify(string[] addresses) =>
        addresses.Where(a => Objects.Exists(o => o.Address == a)).ToDictionary(a => a, a => "id:" + a);

    public string Rename(string address, string newName, string expectedTiaRevision, string operationId)
    {
        var e = Objects.Find(o => o.Address == address) ?? throw new RpcException(ErrorCodes.NotFound, address);
        if (e.Fingerprint != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address);
        var parts = AddressFormat.Parse(address);
        parts.Name = newName;
        e.Address = AddressFormat.Format(parts);
        return e.Address;
    }

    public void Delete(string address, string expectedTiaRevision, string operationId)
    {
        var e = Objects.Find(o => o.Address == address) ?? throw new RpcException(ErrorCodes.NotFound, address);
        if (e.Fingerprint != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address);
        Objects.Remove(e);
    }

    /// <summary>When set, Import takes the file (kept in LastImport with its folder's other files) and returns an export.</summary>
    public bool Imports;
    public Dictionary<string, string> LastImport;
    public string LastImportPath;

    public ExportResult Import(string address, string form, string path, string expectedTiaRevision, string operationId)
    {
        if (!Imports) throw new RpcException(ErrorCodes.UnsupportedCapability, "fake session does not import");
        LastImportPath = path;
        LastImport = Directory.GetFiles(Path.GetDirectoryName(path)).ToDictionary(Path.GetFileName, f => File.ReadAllText(f));
        var outDir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-fake-out", Guid.NewGuid().ToString("N"))).FullName;
        return Export(address, form, outDir);
    }
}
