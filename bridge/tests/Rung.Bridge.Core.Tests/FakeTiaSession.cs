// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

public sealed class FakeTiaSession : ITiaSession
{
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

    public IReadOnlyList<ObjectEntry> ListObjects(string device) => Objects;

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

    public IReadOnlyList<XRefEntry> XRef(string address) =>
        new[] { new XRefEntry { Source = address, SourceName = "Fx_Motor", TargetName = "Start_Button", TargetType = "Tag", TargetAddress = "%I0.0", Access = "Read", ReferenceType = "Uses", Location = "@Fx_Motor NW1" } };

    public void Delete(string address, string expectedTiaRevision, string operationId)
    {
        var e = Objects.Find(o => o.Address == address) ?? throw new RpcException(ErrorCodes.NotFound, address);
        if (e.Fingerprint != expectedTiaRevision) throw new RpcException(ErrorCodes.StaleRevision, address);
        Objects.Remove(e);
    }

    public ExportResult Import(string address, string form, string path, string expectedTiaRevision, string operationId) =>
        throw new RpcException(ErrorCodes.UnsupportedCapability, "fake session does not import");
}
