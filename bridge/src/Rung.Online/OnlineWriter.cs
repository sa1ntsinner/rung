// SPDX-License-Identifier: BUSL-1.1
using System.Reflection;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;

namespace Rung.Online;

internal static class OnlineWriter
{
    public static async Task<WriteResult> SendAsync(ConnectRequest target, PreparedWrite operation, WriterConfiguration policy, CancellationToken token)
    {
        var sent = false;
        WriteResult? completed = null;
        try {
            policy.Verify(target);
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= operation.ExpiresAt) throw new RpcException(ErrorCodes.StalePreparation, "Confirmation expired before writer connection.");
            await using var client = new S7CommPlusClient(OnlineDriver.Options(target, writes: true));
            await client.ConnectAsync(token);
            var cpu = await client.GetCpuInfoAsync(token); var binding = operation.Context.Binding;
            if (cpu.CpuMlfb != binding.Cpu || cpu.CpuSerial != binding.Serial || cpu.PlcName != binding.PlcName || (cpu.CpuFirmware?.ToString() ?? "") != binding.Firmware) throw new RpcException(ErrorCodes.StalePreparation, "Writer PLC identity changed.");
            var symbols = OnlineDriver.SymbolRecords(await client.BrowseAsync(token));
            if (OnlineSession.ProgramRevision(symbols) != binding.ProgramRevision) throw new RpcException(ErrorCodes.StalePreparation, "Writer program structure changed.");
            PlcTag? tag = null;
            if (operation.Action.Action == "modify") {
                var symbol = Symbols.Resolve(operation.Action.Name!, symbols);
                Symbols.ForWrite(operation.Action.Name!, symbols);
                var name = symbol?.Name ?? Symbols.Normalize(operation.Action.Name!);
                var tags = await client.GetTagsBySymbolsAsync([name], token);
                if (!tags.TryGetValue(name, out tag) || tag.AggregateElements.Count != 0 || tag.GetType().GetProperty("Value")?.PropertyType.IsArray != false)
                    throw new RpcException(ErrorCodes.UnsupportedObject, "Writer requires one scalar value.");
                var read = await client.ReadAsync([tag], token);
                if (read.Items.Count != 1 || !read.Items[0].IsSuccess || tag.Quality != PlcTagQC.TAG_QUALITY_GOOD) throw new RpcException(ErrorCodes.AccessDenied, "Cannot observe the writer's scalar value.");
                int? capacity = tag switch { PlcTagString text => text.MaxLength, PlcTagWString text => text.MaxLength, _ => null };
                if (tag.Datatype != operation.Context.Datatype || capacity != operation.Context.MaxLength) throw new RpcException(ErrorCodes.StalePreparation, "Writer type or string capacity changed.");
                var value = WritePolicy.ParseScalar(tag.Datatype, operation.Action.Literal!, capacity);
                try { tag.GetType().GetProperty("Value")!.SetValue(tag, value); }
                catch (TargetInvocationException) { throw new RpcException(ErrorCodes.BadRequest, "Writer rejected the scalar literal."); }
            }
            policy.Verify(target); token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= operation.ExpiresAt) throw new RpcException(ErrorCodes.StalePreparation, "Confirmation expired before sending.");
            sent = true;
            if (tag != null) {
                var written = await client.WriteAsync([tag], token);
                completed = written.Items.Count != 1 ? new("unknown", ErrorCodes.OutcomeUnknown)
                    : written.Items[0].IsSuccess ? new("acknowledged") : new("rejected", ErrorCodes.OnlineFailed);
            } else {
                if (operation.Action.Action == "run") await client.StartCpuAsync(token);
                else if (operation.Action.Action == "stop") await client.StopCpuAsync(token);
                else throw new RpcException(ErrorCodes.BadRequest, "Unknown CPU action.");
                completed = new("acknowledged");
            }
            // A subsequent observation is evidence of PLC state, not proof that the value stayed written.
            if (completed.Outcome == "acknowledged") {
                try {
                    var scope = new LiveScope(binding.Device, binding.Address, "s7commplus", binding.Epoch);
                    if (tag != null) {
                        var observed = await client.ReadAsync([tag], token);
                        if (observed.Items.Count == 1 && observed.Items[0].IsSuccess && tag.Quality == PlcTagQC.TAG_QUALITY_GOOD)
                            completed = completed with { Observation = new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, items = new[] { PlcValues.Read(tag) with { Name = operation.Action.Name! } } } };
                    } else {
                        var want = operation.Action.Action == "run" ? S7CommPlusCpuOperatingState.Run : S7CommPlusCpuOperatingState.Stop;
                        var observed = await CpuSettle.WaitAsync(async () => (await client.GetCpuStateAsync(token)).OperatingState, want, TimeSpan.FromSeconds(10), TimeSpan.FromMilliseconds(250), token);
                        completed = completed with { Observation = new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope,
                            identity = new OnlineIdentity(binding.Cpu, binding.Firmware ?? "", binding.Serial, binding.PlcName), state = new OnlineCpuState(observed.ToString()) } };
                    }
                } catch { /* Keep the acknowledgement even when observation is unavailable. */ }
            }
            return completed;
        } catch (RpcException ex) { return completed ?? new(sent ? "unknown" : "rejected", ex.Code); }
        catch (S7CommPlusException ex) when (ex.ErrorCode is S7Consts.errCliAccessDenied or S7Consts.errCliItemNotAvailable or S7Consts.errCliInvalidParams) { return completed ?? new("rejected", ErrorCodes.AccessDenied); }
        catch { return completed ?? new(sent ? "unknown" : "rejected", sent ? ErrorCodes.OutcomeUnknown : ErrorCodes.OnlineFailed); }
    }
}
