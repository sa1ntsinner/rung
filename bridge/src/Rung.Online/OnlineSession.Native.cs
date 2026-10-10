// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;

namespace Rung.Online;

internal sealed partial class OnlineDriver
{
    public async Task<NativeCaptureResult> CaptureAsync(string block, string instance, CancellationToken token)
    {
        var blocks = await client.BrowseBlocksAsync(token);
        var selected = blocks.Single(b => b.Type == S7CommPlusBlockType.FB && b.Name == block);
        // ponytail: first producer accepts root OB1 calls only; other OB/nested routes are refused.
        var caller = blocks.Single(b => b.Type == S7CommPlusBlockType.OB && b.Number == 1);
        var source = await client.GetBlockContentAsync(selected.RelationId, token);
        var callerSource = await client.GetBlockContentAsync(caller.RelationId, token);
        var routes = NativeSource.RootCallSites(callerSource.FunctionalObjectDebugInfo, callerSource.BlockBody.ToArray(), callerSource.InternalReferences.ToArray(), instance);
        if (routes.Any(route => route.FunctionBlock != selected.Number) || source.CodeModifiedTimestampBytes?.Length != 8 || callerSource.CodeModifiedTimestampBytes?.Length != 8)
            throw new RpcException(ErrorCodes.UnsupportedObject, "Native source or instance route is unavailable.");
        var bodies = source.BlockBody.Select(NativeSource.Render).ToArray();
        var pointers = new HashSet<uint>();
        var scalars = source.BlockBody.SelectMany(body => { var found = NativeSource.Scalars(source.FunctionalObjectDebugInfo, body, out var pointer); pointers.Add(pointer); return found; }).ToArray();
        if (pointers.Count != 1) throw new NotSupportedException("Native instance members are addressed through more than one pointer.");
        var guid = Guid.NewGuid().ToByteArray(); uint uid = 0;
        foreach (var part in new[] { 0, 4, 8, 12 }) uid ^= BitConverter.ToUInt32(guid, part);
        var plan = NativeCaptureEncoder.Build(selected.Number, pointers.Single(), source.CodeModifiedTimestampBytes, scalars, uid);
        var samples = new List<NativeCaptureObservation>();
        var sync = new object(); Exception? failure = null; NativeRootCall? route = null;
        var received = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using (var subscription = await client.OpenBlockOnlineViewAsync(plan.Request, new() { NotificationTimeout = TimeSpan.FromSeconds(2) }, token)) {
            void Fail(Exception error) { lock (sync) { failure ??= error; received.TrySetException(error); } }
            subscription.CommunicationError += (_, e) => Fail(e.Exception);
            subscription.NotificationReceived += (_, e) => {
                try {
                    var notification = e.Notification;
                    if (notification.JobEnabled != true) throw new NotSupportedException("Native watch is disabled or unknown.");
                    var frame = NativeCaptureEncoder.RootCaller(notification.RawResult);
                    if (frame.Number != caller.Number) throw new NotSupportedException("Native caller changed.");
                    var actualRoute = routes.Single(r => r.Sac == frame.Sac);
                    var state = NativeCaptureEncoder.Decode(plan, notification.RawResult);
                    lock (sync) {
                        if (route != null && route != actualRoute) throw new NotSupportedException("Native call site changed during collection.");
                        route = actualRoute;
                        if (samples.Count < 8) samples.Add(new(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), notification.SequenceNumber, state));
                        if (samples.Count >= 3) received.TrySetResult();
                    }
                } catch (Exception error) { Fail(error); }
            };
            await received.Task.WaitAsync(token);
        }
        lock (sync) if (failure != null) throw failure;
        var current = await client.GetBlockContentAsync(selected.RelationId, token);
        var currentCaller = await client.GetBlockContentAsync(caller.RelationId, token);
        if (!current.CodeModifiedTimestampBytes.AsSpan().SequenceEqual(source.CodeModifiedTimestampBytes)
            || !currentCaller.CodeModifiedTimestampBytes.AsSpan().SequenceEqual(callerSource.CodeModifiedTimestampBytes)
            || !NativeSource.RootCallSites(currentCaller.FunctionalObjectDebugInfo, currentCaller.BlockBody.ToArray(), currentCaller.InternalReferences.ToArray(), instance).SequenceEqual(routes))
            throw new RpcException(ErrorCodes.UnsupportedObject, "Native source changed during capture.");
        lock (sync) return new(bodies, scalars, route!, Convert.ToBase64String(source.CodeModifiedTimestampBytes), samples.ToArray());
    }
}

public sealed partial class OnlineSession
{
    public async Task<OnlineNativeCapture> CaptureAsync(string block, string instance, LiveScope expected, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(block) || block.Length > 128 || string.IsNullOrWhiteSpace(instance) || instance.Length > 128)
            throw new RpcException(ErrorCodes.BadRequest, "Native capture requires bounded block and instance names.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        await gate.WaitAsync(timeout.Token);
        try {
            void Current() {
                ObjectDisposedException.ThrowIf(disposed, this);
                timeout.Token.ThrowIfCancellationRequested();
                if (disconnected || terminal || recovering != 0 || Info.Scope != expected)
                    throw new RpcException(ErrorCodes.OnlineFailed, "Native capture scope changed or session is recovering.");
            }
            Current();
            var capture = await driver.CaptureAsync(block, instance, timeout.Token);
            Current();
            if (capture.Route.Instance != instance || capture.Samples.Length is 0 or > 8)
                throw new RpcException(ErrorCodes.UnsupportedObject, "Native capture instance changed or collection is incomplete.");
            return new(Info.Scope, capture);
        } finally { gate.Release(); }
    }
}
