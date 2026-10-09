// SPDX-License-Identifier: BUSL-1.1
using System.Security.Cryptography;
using System.Text.Json;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver.ClientApi;

namespace Rung.Online;

public sealed partial class OnlineSession
{
    ConnectRequest? target;
    WriteOperationEngine? operations;
    WriteOperationEngine Writer => operations ?? throw new RpcException(ErrorCodes.WritesDisabled, "This read host has no writer policy.");
    public Task<PreparedWrite> PrepareAsync(WriteAction action, CancellationToken token) => Writer.PrepareAsync(action, token);
    public Task<WriteResult> CommitAsync(string id, string preview, bool confirmed, CancellationToken token) => Writer.CommitAsync(id, preview, confirmed, token);
    internal static string ProgramRevision(OnlineSymbol[] symbols) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(symbols.OrderBy(s => s.Name, StringComparer.Ordinal), RpcWire.Json)));

    async Task<WriteContext> ResolveWriteContextAsync(WriteAction action, CancellationToken token) {
        await gate.WaitAsync(token);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (disconnected || terminal || recovering != 0) throw new RpcException(ErrorCodes.StalePreparation, "Session is disconnected or recovering.");
            writerConfiguration!.Verify(target!);
            var identity = await driver.IdentityAsync(token);
            var current = await driver.BrowseAsync(token);
            if (catalog != null && ProgramRevision(current) != ProgramRevision(catalog)) {
                BeginRecovery(new RpcException(ErrorCodes.OnlineFailed, "PLC program structure changed."));
                throw new RpcException(ErrorCodes.StalePreparation, "PLC program structure changed.");
            }
            catalog = current;
            var binding = new WriteBinding(writerConfiguration.Workspace, Info.Scope.Device, Info.Scope.Address, target!.CertificateSha256!,
                identity.Cpu, identity.Serial, identity.PlcName, Info.Scope.Epoch, writerConfiguration.ConfigRevision, ProgramRevision(current), writerConfiguration.AllowWrites, identity.Firmware);
            if (action.Action != "modify") return new(binding, CurrentDisplay: (await driver.StateAsync(token)).Mode);
            var row = (await ReadCoreAsync([action.Name!], token))[0];
            if (row.ErrorCode != null) throw new RpcException(row.ErrorCode, "Cannot modify this PLC symbol.");
            var symbol = Symbols.Resolve(action.Name!, current);
            Symbols.ForWrite(action.Name!, current);
            var canonical = symbol?.Name ?? Symbols.Normalize(action.Name!);
            if (!accessors.TryGetValue(canonical, out var tag) || tag.AggregateElements.Count != 0 || tag.GetType().GetProperty("Value")?.PropertyType.IsArray != false)
                throw new RpcException(ErrorCodes.UnsupportedObject, "Modify one scalar array element or member at a time.");
            int? length = tag switch { PlcTagString text => text.MaxLength, PlcTagWString text => text.MaxLength, _ => null };
            return new(binding, tag.Datatype, length, row.Display);
        } finally { gate.Release(); }
    }
}
