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
        // ponytail: OB1 calls only (other OBs are refused); an instance DB called there, or a multi-instance below it
        // ("Line_DB.motor.valve": each member called as #member in the FB before it)
        var caller = blocks.Single(b => b.Type == S7CommPlusBlockType.OB && b.Number == 1);
        var source = await client.GetBlockContentAsync(selected.RelationId, token);
        var callerSource = await client.GetBlockContentAsync(caller.RelationId, token);
        var path = instance.Split('.');
        if (path.Length > 9 || path.Any(string.IsNullOrWhiteSpace)) throw new RpcException(ErrorCodes.BadRequest, "Invalid instance path.");
        var routes = NativeSource.RootCallSites(callerSource.FunctionalObjectDebugInfo, callerSource.BlockBody.ToArray(), callerSource.InternalReferences.ToArray(), path[0]);
        if (routes.Select(r => r.FunctionBlock).Distinct().Count() != 1 || source.CodeModifiedTimestampBytes?.Length != 8 || callerSource.CodeModifiedTimestampBytes?.Length != 8)
            throw new RpcException(ErrorCodes.UnsupportedObject, "Native source or instance route is unavailable.");
        var chain = new List<(uint Fb, uint[] Sacs, uint RelationId, byte[] Signature)>();
        var callee = routes[0].FunctionBlock;
        foreach (var member in path.Skip(1))
        {
            var outer = blocks.Single(b => b.Type == S7CommPlusBlockType.FB && b.Number == callee);
            var content = await client.GetBlockContentAsync(outer.RelationId, token);
            var site = NativeSource.MemberCallSites(content.FunctionalObjectDebugInfo, content.BlockBody.ToArray(), content.InternalReferences.ToArray(), member);
            chain.Add((callee, site.Sacs, outer.RelationId, content.CodeModifiedTimestampBytes));
            callee = site.Callee;
        }
        if (callee != selected.Number) throw new RpcException(ErrorCodes.UnsupportedObject, $"{instance} is no instance of {block}.");
        var bodies = source.BlockBody.Select(NativeSource.Render).ToArray();
        var pointers = new HashSet<uint>();
        var scalars = source.BlockBody.SelectMany(body => { var found = NativeSource.Scalars(source.FunctionalObjectDebugInfo, body, out var pointer); pointers.Add(pointer); return found; }).ToArray();
        if (pointers.Count != 1) throw new NotSupportedException("Native instance members are addressed through more than one pointer.");
        var constants = source.BlockBody.SelectMany(body => NativeSource.Constants(source.FunctionalObjectDebugInfo, body))
            .GroupBy(c => c.Name).Select(g => g.Distinct().Count() == 1 ? g.First() : throw new NotSupportedException("Native constant #" + g.Key + " shows two values.")).ToArray();
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
                    var frames = NativeCaptureEncoder.CallerFrames(notification.RawResult);
                    if (frames.Length != 1 + chain.Count || frames[0].Number != caller.Number) throw new NotSupportedException("Native caller changed.");
                    for (var i = 0; i < chain.Count; i++)
                        if (frames[i + 1].Number != chain[i].Fb || !chain[i].Sacs.Contains(frames[i + 1].Sac)) throw new NotSupportedException("Native call chain differs from the instance path.");
                    var actualRoute = routes.Single(r => r.Sac == frames[0].Sac);
                    if (chain.Count > 0) actualRoute = actualRoute with { Instance = instance, Sac = frames[^1].Sac };
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
            || !NativeSource.RootCallSites(currentCaller.FunctionalObjectDebugInfo, currentCaller.BlockBody.ToArray(), currentCaller.InternalReferences.ToArray(), path[0]).SequenceEqual(routes))
            throw new RpcException(ErrorCodes.UnsupportedObject, "Native source changed during capture.");
        foreach (var link in chain)
            if (!(await client.GetBlockContentAsync(link.RelationId, token)).CodeModifiedTimestampBytes.AsSpan().SequenceEqual(link.Signature))
                throw new RpcException(ErrorCodes.UnsupportedObject, "Native source changed during capture.");
        lock (sync) return new(bodies, scalars, route!, Convert.ToBase64String(source.CodeModifiedTimestampBytes), samples.ToArray(), constants);
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
