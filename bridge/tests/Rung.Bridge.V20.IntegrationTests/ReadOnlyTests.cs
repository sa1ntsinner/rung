// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Runtime.Serialization;
using System.Linq;
using System.Reflection;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Rung.Bridge.V20;
using Xunit;

public sealed class LockedFactAttribute : FactAttribute
{
    public LockedFactAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
public sealed class LockedTheoryAttribute : TheoryAttribute
{
    public LockedTheoryAttribute() { if (Environment.GetEnvironmentVariable("RUNG_READ_ONLY") != "1") Skip = "Run in a separate process with RUNG_READ_ONLY=1."; }
}
[Trait("Category", "ReadOnly")]
public class ReadOnlyTests
{
    [LockedTheory]
    [InlineData("--upgrade")]
    [InlineData("--retrieve")]
    public void LocalCopyOperationsReachNormalArgumentValidation(string operation)
    {
        Assert.Equal(64, Program.Main(new[] { operation }));
    }

    [LockedFact]
    public void ReadOnlyArgumentIsAcceptedAlongsideLegacyPermissionFlags()
    {
        var args = BridgeArgs.Parse(new[] { "--read-only", "--allow-import", "--allow-download", "--create-project" });
        Assert.NotNull(args);
    }

    [LockedTheory]
    [InlineData("Download")]
    [InlineData("UploadStation")]
    [InlineData("Delete")]
    [InlineData("Rename")]
    [InlineData("Import")]
    [InlineData("Compile")]
    [InlineData("CompileHardware")]
    [InlineData("ApplyHardware")]
    [InlineData("ReleaseLibrary")]
    [InlineData("ApplyMasterCopy")]
    [InlineData("ImportLibrary")]
    [InlineData("UpdateLibrary")]
    [InlineData("ImportProjectArtifact")]
    public void PlcMutationsRefuseBeforeAnyTiaObjectIsUsed(string name)
    {
        var session = (OpennessSession)FormatterServices.GetUninitializedObject(typeof(OpennessSession));
        var method = typeof(OpennessSession).GetMethod(name);
        var parameters = method.GetParameters().Select(p => p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null).ToArray();
        var error = Assert.Throws<TargetInvocationException>(() => method.Invoke(session, parameters));
        Assert.Equal("PLC_READ_ONLY", Assert.IsType<RpcException>(error.InnerException).Code);
    }
}
