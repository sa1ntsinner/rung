// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public sealed record WriteBinding(string Workspace, string Device, string Address, string CertificateSha256, string Cpu,
    string Serial, string PlcName, long Epoch, string ConfigRevision, string ProgramRevision, bool AllowWrites, string? Firmware = null);
public sealed record WriteAction(string Action, string? Name = null, string? Literal = null);
public sealed record WriteContext(WriteBinding Binding, uint? Datatype = null, int? MaxLength = null, string? CurrentDisplay = null);
public sealed record PreparedWrite(string OperationId, string Preview, long ExpiresAt, WriteAction Action, WriteContext Context, object? Value);
public sealed record WriteResult(string Outcome, string? ErrorCode = null, object? Observation = null);

/// <summary>Resolve comes from the trusted session/configuration, not RPC-supplied mutation policy.</summary>
public sealed class WriteOperationEngine(Func<WriteAction, CancellationToken, Task<WriteContext>> resolve,
    Func<PreparedWrite, CancellationToken, Task<WriteResult>> send, Func<long>? clock = null)
{
    readonly Dictionary<string, PreparedWrite> operations = new();
    long Now() => clock?.Invoke() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    static RpcException Stale() => new(ErrorCodes.StalePreparation, "Preparation expired or PLC, configuration, type or program changed.");
    static void Check(WriteBinding binding) {
        OnlineDispatcher.ValidateTarget(binding.Address);
        if (!binding.AllowWrites) throw new RpcException(ErrorCodes.WritesDisabled, "PLC modification is not opted in.");
        if (binding.CertificateSha256.Length != 64 || !binding.CertificateSha256.All(Uri.IsHexDigit)) throw new RpcException(ErrorCodes.CertificateUntrusted, "PLC certificate must be independently verified.");
        if (binding.Epoch < 1 || new[] { binding.Workspace, binding.Device, binding.Cpu, binding.Serial, binding.PlcName, binding.ConfigRevision, binding.ProgramRevision }.Any(string.IsNullOrWhiteSpace)) throw Stale();
    }

    public async Task<PreparedWrite> PrepareAsync(WriteAction action, CancellationToken token = default) {
        if (action.Action is not ("modify" or "run" or "stop") || action.Action == "modify" && (string.IsNullOrWhiteSpace(action.Name) || action.Name.Length > 1024 || string.IsNullOrWhiteSpace(action.Literal)) || action.Action != "modify" && (action.Name != null || action.Literal != null))
            throw new RpcException(ErrorCodes.BadRequest, "Prepare one scalar modification or CPU action.");
        var context = await resolve(action, token); Check(context.Binding);
        var value = action.Action == "modify" ? WritePolicy.ParseScalar(context.Datatype ?? throw Stale(), action.Literal!, context.MaxLength) : null;
        var b = context.Binding;
        var preview = $"{b.Device} · {b.PlcName} · {b.Address}\n{b.Cpu} · {b.Serial}\n{action.Action}";
        if (action.Action == "modify") preview += $" {action.Name}: {PlcValues.TypeName(context.Datatype!.Value)} := {action.Literal}";
        if (context.CurrentDisplay != null) preview += $"\nObserved: {context.CurrentDisplay}";
        var operation = new PreparedWrite(Guid.NewGuid().ToString("N"), preview, Now() + 30_000, action, context, value);
        lock (operations) {
            foreach (var id in operations.Where(p => p.Value.ExpiresAt <= Now()).Select(p => p.Key).ToArray()) operations.Remove(id);
            if (operations.Count >= 128) throw new RpcException(ErrorCodes.ResourceLimit, "Too many pending confirmations.");
            operations.Add(operation.OperationId, operation);
        }
        return operation;
    }

    public async Task<WriteResult> CommitAsync(string id, string preview, bool confirmed, CancellationToken token = default) {
        PreparedWrite? operation;
        lock (operations) operations.Remove(id, out operation);
        if (operation == null || operation.Preview != preview) throw Stale();
        if (!confirmed) throw new RpcException(ErrorCodes.WritesDisabled, "Explicit confirmation is required.");
        var current = await resolve(operation.Action, token);
        if (Now() >= operation.ExpiresAt || current.Binding != operation.Context.Binding || current.Datatype != operation.Context.Datatype || current.MaxLength != operation.Context.MaxLength) throw Stale();
        Check(current.Binding); token.ThrowIfCancellationRequested();
        try { return await send(operation, token); }
        catch { return new("unknown", ErrorCodes.OutcomeUnknown); }
    }
    public void Invalidate() { lock (operations) operations.Clear(); }
}
