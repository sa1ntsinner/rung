// SPDX-License-Identifier: BUSL-1.1
using System.Security.Cryptography;
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

/// <summary>Supplied once by the trusted broker over the private startup pipe, never by commit parameters.</summary>
public sealed record WriterConfiguration(string Workspace, string ConfigRevision, string Device, string Address, string CertificateSha256, bool AllowWrites)
{
    public void Verify(ConnectRequest target)
    {
        OnlineDispatcher.ValidateTarget(target.Address);
        if (!AllowWrites) throw new RpcException(ErrorCodes.WritesDisabled, "PLC modification is not opted in.");
        if (target.Device != Device || target.Address != Address || !string.Equals(target.CertificateSha256, CertificateSha256, StringComparison.OrdinalIgnoreCase))
            throw new RpcException(ErrorCodes.StalePreparation, "Startup policy does not authorize this PLC target.");
        if (CertificateSha256.Length != 64 || !CertificateSha256.All(Uri.IsHexDigit)) throw new RpcException(ErrorCodes.CertificateUntrusted, "Verify the PLC certificate first.");
        var file = new FileInfo(Path.Combine(Path.GetFullPath(Workspace), "rung.toml"));
        if (!file.Exists || file.Length > 1_000_000 || !string.Equals(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file.FullName))), ConfigRevision, StringComparison.OrdinalIgnoreCase))
            throw new RpcException(ErrorCodes.StalePreparation, "Workspace configuration changed; prepare again.");
    }
}
