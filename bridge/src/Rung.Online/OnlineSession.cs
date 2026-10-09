// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;

namespace Rung.Online;

public sealed record ConnectRequest(string Device, string Address, string? CertificateSha256 = null, string? User = null, string? Password = null);
public sealed record LiveScope(string Device, string Address, string Transport, long Epoch);
public sealed record OnlineIdentity(string Cpu, string Firmware, string Serial, string PlcName);
public sealed record SessionInfo(string SessionId, LiveScope Scope, OnlineIdentity Identity, string[] Capabilities);
public sealed record OnlineSymbol(string Name, uint Datatype, bool Readable, uint ArrayElementCount, string? AccessFingerprint = null, string? AbsoluteAddress = null, bool Writable = true);
public sealed record OnlineMemory(string Name, long TotalBytes, long UsedBytes);
public sealed record OnlineCpuState(string Mode, double? CycleMs = null, OnlineMemory[]? Memory = null, string[]? Unavailable = null);
public sealed record OnlineReadItem(string Name, object? Value = null, string? Type = null, string? Display = null, long? ObservedAt = null, string? Error = null, string? ErrorCode = null);

/// <summary>The host exposes only these driver operations; no mutation surface.</summary>
public interface IOnlineDriver : IAsyncDisposable
{
    Task ConnectAsync(CancellationToken token);
    Task<OnlineIdentity> IdentityAsync(CancellationToken token);
    Task<OnlineSymbol[]> BrowseAsync(CancellationToken token);
    Task<IReadOnlyDictionary<string, PlcTag>> ResolveAsync(string[] names, CancellationToken token);
    Task<S7CommPlusBatchResult<S7CommPlusTagReadResult>> ReadAsync(PlcTag[] tags, CancellationToken token);
    Task<OnlineCpuState> StateAsync(CancellationToken token);
    Task<OnlineAlarm[]> AlarmsAsync(int lcid, CancellationToken token) => throw new RpcException(ErrorCodes.UnsupportedCapability, "Alarms unavailable.");
    Task<IAsyncDisposable> SubscribeAlarmsAsync(int lcid, Action<OnlineAlarm[], bool> notify, Action<Exception> fail, CancellationToken token) => throw new RpcException(ErrorCodes.UnsupportedCapability, "Alarms unavailable.");
    Task InvalidateAsync(CancellationToken token) => Task.CompletedTask;
    Task DisconnectAsync(CancellationToken token) => Task.CompletedTask;
    Task<IAsyncDisposable> SubscribeAsync(PlcTag[] tags, int cycleMs, Action<OnlineReadItem[]> notify, Action<Exception> fail, CancellationToken token) => throw new NotSupportedException();
}

internal sealed partial class OnlineDriver : IOnlineDriver
{
    readonly S7CommPlusClient client;
    readonly ConnectRequest target;
    public OnlineDriver(ConnectRequest request)
    {
        target = request;
        client = new(Options(request));
    }
    internal static S7CommPlusClientOptions Options(ConnectRequest request, bool writes = false) {
        OnlineDispatcher.ValidateTarget(request.Address);
        return new S7CommPlusClientOptions {
            Address = request.Address, CertificateSha256 = request.CertificateSha256,
            Username = request.User ?? "", Password = request.Password ?? "",
            SecurityMode = S7CommPlusSecurityMode.Tls, TlsBackend = S7CommPlusTlsBackend.BouncyCastle,
            WriteEnabled = writes, AutoReconnect = false,
        };
    }
    public Task ConnectAsync(CancellationToken token) => client.ConnectAsync(token);
    public async Task<OnlineIdentity> IdentityAsync(CancellationToken token) {
        var cpu = await client.GetCpuInfoAsync(token);
        return new(cpu.CpuMlfb, cpu.CpuFirmware?.ToString() ?? "", cpu.CpuSerial, cpu.PlcName);
    }
    internal static OnlineSymbol[] SymbolRecords(IEnumerable<VarInfo> variables) => variables.Select(v => new OnlineSymbol(v.Name, v.Softdatatype, v.HmiAccessible, v.ArrayElementCount,
        $"{v.AccessSequence}:{v.SymbolCrc:X8}:{v.OptAddress}:{v.OptBitoffset}:{string.Join(",", v.ArrayDimensions.Select(d => $"{d.LowerBound}/{d.ElementCount}"))}", AbsoluteAddress.FromMetadata(v), v.HmiAccessible && !v.HmiReadonly)).ToArray();
    public async Task<OnlineSymbol[]> BrowseAsync(CancellationToken token) => SymbolRecords(await client.BrowseAsync(token));
    public Task<IReadOnlyDictionary<string, PlcTag>> ResolveAsync(string[] names, CancellationToken token) => client.GetTagsBySymbolsAsync(names, token);
    public Task<S7CommPlusBatchResult<S7CommPlusTagReadResult>> ReadAsync(PlcTag[] tags, CancellationToken token) => client.ReadAsync(tags, token);
    public async Task<OnlineCpuState> StateAsync(CancellationToken token) {
        var state = await client.GetCpuStateAsync(token);
        double? cycle = null; OnlineMemory[]? memory = null;
        var unavailable = new List<string>();
        try { cycle = (await client.GetCpuCycleTimeAsync(token)).CurrentMilliseconds; } catch (Exception ex) when (MetadataUnavailable(ex)) { unavailable.Add("cycle"); }
        try { memory = (await client.GetCpuMemoryUsageAsync(token)).Areas.Select(a => new OnlineMemory(a.Name, a.TotalBytes, a.UsedBytes)).ToArray(); } catch (Exception ex) when (MetadataUnavailable(ex)) { unavailable.Add("memory"); }
        return new(state.OperatingState.ToString(), cycle, memory, unavailable.Count == 0 ? null : unavailable.ToArray());
    }
    static bool MetadataUnavailable(Exception error) => error is NotSupportedException || error is S7CommPlusException s7 && s7.ErrorCode is S7Consts.errCliAccessDenied or S7Consts.errCliItemNotAvailable or S7Consts.errCliFunNotAvailable or S7Consts.errCliFunctionNotImplemented;
    public ValueTask DisposeAsync() => client.DisposeAsync();
    public Task InvalidateAsync(CancellationToken token) => client.InvalidateSymbolCatalogAsync(token);
    public Task DisconnectAsync(CancellationToken token) => client.DisconnectAsync(token);
    public async Task<IAsyncDisposable> SubscribeAsync(PlcTag[] tags, int cycleMs, Action<OnlineReadItem[]> notify, Action<Exception> fail, CancellationToken token) {
        var subscription = await client.SubscribeTagsAsync(tags, new S7CommPlusSubscriptionOptions { CycleTimeMilliseconds = (ushort)cycleMs, MaxConsecutiveTimeoutsBeforeFault = 0 }, token);
        subscription.NotificationReceived += (_, args) => {
            var at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            notify(args.Notification.Items.Where(i => i.Tag != null).Select(i => {
                if (!i.IsSuccess) return new OnlineReadItem(i.Tag.Name, Error: "PLC rejected subscription item.", ErrorCode: i.ItemError == 0x13 ? ErrorCodes.AccessDenied : ErrorCodes.OnlineFailed);
                if (i.Tag.Quality != PlcTagQC.TAG_QUALITY_GOOD) return new OnlineReadItem(i.Tag.Name, Error: "PLC value quality is bad.", ErrorCode: ErrorCodes.UnsupportedObject);
                try { return PlcValues.Read(i.Tag) with { ObservedAt = at }; }
                catch (RpcException ex) { return new OnlineReadItem(i.Tag.Name, Error: ex.Message, ErrorCode: ex.Code); }
            }).ToArray());
        };
        subscription.CommunicationError += (_, args) => fail(args.Exception);
        return subscription;
    }
}

public sealed partial class OnlineSession(IOnlineDriver driver, WriterConfiguration? writerConfiguration = null,
    Func<ConnectRequest, PreparedWrite, CancellationToken, Task<WriteResult>>? send = null) : IAsyncDisposable
{
    public SessionInfo Info { get; private set; } = null!;
    OnlineSymbol[]? catalog;
    readonly Dictionary<string, PlcTag> accessors = new(StringComparer.Ordinal);
    readonly Dictionary<string, OnlineSubscription> subscriptions = new();
    readonly SemaphoreSlim gate = new(1, 1);
    readonly CancellationTokenSource lifetime = new();
    int recovering;
    readonly object recoveryLock = new();
    Exception? recoveryFailure;
    Task recovery = Task.CompletedTask;
    Task health = Task.CompletedTask;
    bool disposed;
    bool terminal;
    bool disconnected;
    public event Action<object>? Values;
    public async Task<object> SubscribeAsync(string[] names, int cycleMs, CancellationToken token) {
        await gate.WaitAsync(token);
        try {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (terminal) throw new RpcException(ErrorCodes.OnlineFailed, "Session is disconnected.");
        if (names.Length == 0 || names.Length > 1024 || cycleMs < 50 || cycleMs > 65535 || subscriptions.Count >= 64)
            throw new RpcException(ErrorCodes.ResourceLimit, "Subscription requires 1..1024 names, 50..65535 ms cycle and at most 64 leases.");
        if (disconnected && recovering == 0) BeginRecovery(new IOException("PLC disconnected."));
        var rows = recovering != 0
            ? names.Select(name => new OnlineReadItem(name, Error: "PLC reconnecting.", ErrorCode: ErrorCodes.OnlineFailed)).ToArray()
            : await ReadCoreAsync(names, token);
        var subscription = new OnlineSubscription(names, rows, cycleMs);
        subscriptions.Add(subscription.Id, subscription);
        if (health == Task.CompletedTask) health = Task.Run(HealthLoopAsync);
        try { if (recovering == 0) await StartSubscriptionAsync(subscription, token); }
        catch { subscriptions.Remove(subscription.Id); await subscription.DisposeAsync(); throw; }
        return new { subscriptionId = subscription.Id, snapshot = new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = Info.Scope, items = subscription.Snapshot, connectionState = recovering != 0 ? "reconnecting" : "connected" } };
        } finally { gate.Release(); }
    }
    async Task StartSubscriptionAsync(OnlineSubscription subscription, CancellationToken token) {
        var generation = ++subscription.Generation;
        var aliases = subscription.Snapshot.Where(r => r.ErrorCode == null).DistinctBy(r => Symbols.Normalize(r.Name)).ToDictionary(
            r => Symbols.Normalize(r.Name), r => Symbols.Resolve(r.Name, catalog!)?.Name ?? Symbols.Normalize(r.Name), StringComparer.Ordinal);
        var selected = aliases.Values.Where(accessors.ContainsKey).Select(n => accessors[n]).Distinct().ToArray();
        if (selected.Length == 0) return;
        subscription.Lease = await driver.SubscribeAsync(selected, subscription.CycleMs, rows => {
            lock (subscription) {
                if (disposed || subscription.Disposed || generation != subscription.Generation) return;
                subscription.Merge(rows, aliases);
                if (recovering == 0) Emit(subscription, "connected");
            }
        }, error => { lock (subscription) { if (!subscription.Disposed && generation == subscription.Generation) BeginRecovery(error); } }, token);
    }
    void Emit(OnlineSubscription subscription, string connectionState, string? errorCode = null) => Values?.Invoke(new {
        sessionId = Info.SessionId, subscriptionId = subscription.Id, at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = Info.Scope,
        items = subscription.Snapshot, connectionState, errorCode
    });
    public async Task<bool> UnsubscribeAsync(string id) {
        await gate.WaitAsync();
        try {
        if (alarmLeases.Remove(id, out var alarms)) { await alarms.DisposeAsync(); return true; }
        if (!subscriptions.Remove(id, out var subscription)) return false;
        await subscription.DisposeAsync(); return true;
        } finally { gate.Release(); }
    }
    void BeginRecovery(Exception error) {
        lock (recoveryLock) {
            if (disposed || terminal) return;
            if (recovering != 0) { recoveryFailure ??= error; return; }
            disconnected = true;
            recovering = 1;
            recovery = Task.Run(() => RecoverAsync(error));
        }
    }
    async Task RecoverAsync(Exception error) {
        var token = lifetime.Token;
        var recovered = false;
        try {
            await gate.WaitAsync(token);
            try {
                foreach (var subscription in subscriptions.Values) {
                    subscription.Generation++;
                    Emit(subscription, "reconnecting", OnlineDispatcher.FailureCode(error));
                }
                foreach (var lease in alarmLeases.Values) { lease.Generation++; AlarmsChanged?.Invoke(AlarmFrame(lease, "reconnecting", OnlineDispatcher.FailureCode(error))); }
                // Retry transient outages with a capped delay until the consumers leave.
                for (var attempt = 0; LeaseCount > 0 && !Fatal(error); attempt++) {
                    try {
                        lock (recoveryLock) recoveryFailure = null;
                        // Leases can close while the PLC is offline; do not hold the session gate during backoff.
                        gate.Release();
                        try { await Task.Delay(TimeSpan.FromSeconds(attempt < 4 ? 1 << attempt : 15), token); }
                        finally { await gate.WaitAsync(); }
                        if (LeaseCount == 0) break;
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                        timeout.CancelAfter(TimeSpan.FromSeconds(15));
                        var attemptToken = timeout.Token;
                        foreach (var subscription in subscriptions.Values) {
                            if (subscription.Lease != null) { await subscription.Lease.DisposeAsync(); subscription.Lease = null; }
                        }
                        foreach (var lease in alarmLeases.Values) { if (lease.Lease != null) { await lease.Lease.DisposeAsync(); lease.Lease = null; } }
                        await driver.DisconnectAsync(attemptToken);
                        accessors.Clear(); catalog = null;
                        await driver.InvalidateAsync(attemptToken);
                        await driver.ConnectAsync(attemptToken);
                        var identity = await driver.IdentityAsync(attemptToken);
                        if (identity.Cpu != Info.Identity.Cpu || identity.Serial != Info.Identity.Serial || identity.PlcName != Info.Identity.PlcName)
                            throw new RpcException(ErrorCodes.TargetRefused, "PLC identity changed; establish a new session explicitly.");
                        Info = Info with { Scope = Info.Scope with { Epoch = Info.Scope.Epoch + 1 }, Identity = identity };
                        foreach (var subscription in subscriptions.Values) {
                            var snapshot = await ReadCoreAsync(subscription.Names, attemptToken);
                            lock (subscription) subscription.Snapshot = snapshot;
                            await StartSubscriptionAsync(subscription, attemptToken);
                        }
                        foreach (var lease in alarmLeases.Values) await StartAlarmLeaseAsync(lease, attemptToken);
                        lock (recoveryLock) {
                            if (recoveryFailure != null) throw recoveryFailure;
                            recovering = 0;
                            disconnected = false;
                            recovered = true;
                        }
                        foreach (var subscription in subscriptions.Values) Emit(subscription, "connected");
                        foreach (var lease in alarmLeases.Values) AlarmsChanged?.Invoke(AlarmFrame(lease));
                        return;
                    } catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                    catch (Exception ex) {
                        error = ex;
                        if (Fatal(ex)) break;
                    }
                }
                terminal = Fatal(error);
                foreach (var subscription in subscriptions.Values) {
                    subscription.Generation++;
                    if (subscription.Lease != null) { await subscription.Lease.DisposeAsync(); subscription.Lease = null; }
                    Emit(subscription, "disconnected", OnlineDispatcher.FailureCode(error));
                }
                foreach (var lease in alarmLeases.Values) {
                    lease.Generation++;
                    if (lease.Lease != null) { await lease.Lease.DisposeAsync(); lease.Lease = null; }
                    AlarmsChanged?.Invoke(AlarmFrame(lease, "disconnected", OnlineDispatcher.FailureCode(error)));
                }
            } finally { if (!recovered) lock (recoveryLock) recovering = 0; gate.Release(); }
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { lock (recoveryLock) recovering = 0; }
    }
    static bool Fatal(Exception ex) => OnlineDispatcher.FailureCode(ex) is ErrorCodes.CertificateUntrusted or ErrorCodes.AuthenticationFailed or ErrorCodes.AuthenticationRequired or ErrorCodes.TlsUnsupported or ErrorCodes.AccessDenied or ErrorCodes.TargetRefused;
    public async Task ConnectAsync(ConnectRequest request, CancellationToken token, long epoch = 1) {
        await driver.ConnectAsync(token);
        Info = new(Guid.NewGuid().ToString("N"), new(request.Device, request.Address, "s7commplus", epoch), await driver.IdentityAsync(token), OnlineDispatcher.Capabilities);
        target = request;
        if (writerConfiguration != null) operations = new(ResolveWriteContextAsync, (operation, ct) => (send ?? ((r, o, t) => OnlineWriter.SendAsync(r, o, writerConfiguration, t)))(request, operation, ct));
    }
    public async Task<OnlineSymbol[]> BrowseAsync(CancellationToken token) => catalog ??= await driver.BrowseAsync(token);
    public Task<OnlineCpuState> StateAsync(CancellationToken token) => CheckHealthAsync(true, token);
    async Task<OnlineCpuState> CheckHealthAsync(bool inspectCatalog, CancellationToken token) {
        await gate.WaitAsync(token);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (disconnected || terminal || recovering != 0) throw new RpcException(ErrorCodes.OnlineFailed, "Session is disconnected or recovering.");
            var state = await driver.StateAsync(token);
            if (inspectCatalog && subscriptions.Count > 0 && catalog != null && !terminal) {
                var current = await driver.BrowseAsync(token);
                if (!catalog.OrderBy(s => s.Name, StringComparer.Ordinal).SequenceEqual(current.OrderBy(s => s.Name, StringComparer.Ordinal)))
                    BeginRecovery(new RpcException(ErrorCodes.OnlineFailed, "PLC program structure changed."));
            }
            return state;
        } finally { gate.Release(); }
    }
    async Task HealthLoopAsync() {
        try {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
            var tick = 0;
            while (await timer.WaitForNextTickAsync(lifetime.Token)) {
                if (disconnected || terminal || recovering != 0 || LeaseCount == 0) continue;
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                try { await CheckHealthAsync(++tick % 6 == 0, timeout.Token); }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
                catch (Exception ex) { BeginRecovery(ex); }
            }
        } catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }
    public async Task<OnlineReadItem[]> ReadAsync(string[] names, CancellationToken token)
    {
        await gate.WaitAsync(token);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (disconnected || terminal || recovering != 0) throw new RpcException(ErrorCodes.OnlineFailed, "Session is disconnected or recovering.");
            return await ReadCoreAsync(names, token);
        }
        finally { gate.Release(); }
    }
    async Task<OnlineReadItem[]> ReadCoreAsync(string[] names, CancellationToken token)
    {
        if (names.Length > 1024) throw new RpcException(ErrorCodes.ResourceLimit, "At most 1024 names per read.");
        var rows = new OnlineReadItem?[names.Length];
        var resolved = new Dictionary<int, string>();
        var symbols = await BrowseAsync(token);
        for (var i = 0; i < names.Length; i++) {
            try {
                var symbol = Symbols.Resolve(names[i], symbols);
                if (symbol != null && !symbol.Readable) throw new RpcException(ErrorCodes.AccessDenied, "PLC denies access to this symbol.");
                // Indexed elements may be synthesized by the driver's catalog from an aggregate array.
                resolved[i] = symbol?.Name ?? Symbols.Normalize(names[i]);
            } catch (RpcException ex) { rows[i] = new(names[i], Error: ex.Message, ErrorCode: ex.Code); }
        }
        var needed = resolved.Values.Where(n => !accessors.ContainsKey(n)).Distinct(StringComparer.Ordinal).ToArray();
        if (needed.Length > 0) {
            // Resolve one item at a time: a driver exception for an unsupported tag must not discard other items.
            foreach (var name in needed) {
                try {
                    var tags = await driver.ResolveAsync(new[] { name }, token);
                    if (tags.TryGetValue(name, out var tag)) accessors[name] = tag;
                } catch (S7CommPlusException ex) when (ex.ErrorCode is S7Consts.errCliItemNotAvailable or S7Consts.errCliAccessDenied) {
                    foreach (var (index, value) in resolved.Where(x => x.Value == name))
                        rows[index] = new(names[index], Error: "PLC rejected symbol resolution.", ErrorCode: ex.ErrorCode == S7Consts.errCliAccessDenied ? ErrorCodes.AccessDenied : ErrorCodes.SymbolNotFound);
                } catch (NotSupportedException) {
                    foreach (var (index, value) in resolved.Where(x => x.Value == name))
                        rows[index] = new(names[index], Error: "Unsupported PLC datatype.", ErrorCode: ErrorCodes.UnsupportedObject);
                }
            }
        }
        var selected = resolved.Where(x => rows[x.Key] == null && accessors.ContainsKey(x.Value)).Select(x => accessors[x.Value]).Distinct().ToArray();
        var results = (await driver.ReadAsync(selected, token)).Items.ToDictionary(r => r.Tag);
        var observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var (i, name) in resolved) {
            if (rows[i] != null) continue;
            if (!accessors.TryGetValue(name, out var tag)) { rows[i] = new(names[i], Error: "Symbol not found in PLC.", ErrorCode: ErrorCodes.SymbolNotFound); continue; }
            if (!results.TryGetValue(tag, out var item) || !item.IsSuccess) {
                rows[i] = new(names[i], Error: "PLC rejected the read.", ErrorCode: item.ItemError == 0x13 ? ErrorCodes.AccessDenied : ErrorCodes.OnlineFailed);
                continue;
            }
            if (tag.Quality != PlcTagQC.TAG_QUALITY_GOOD) {
                rows[i] = new(names[i], Error: "PLC value could not be decoded with good quality.", ErrorCode: ErrorCodes.UnsupportedObject);
                continue;
            }
            try {
                var value = PlcValues.Read(tag);
                rows[i] = value with { Name = names[i], ObservedAt = observedAt };
            } catch (RpcException ex) { rows[i] = new(names[i], Error: ex.Message, ErrorCode: ex.Code); }
        }
        return rows.Select(r => r!).ToArray();
    }
    public async ValueTask DisposeAsync() {
        if (disposed) return;
        disposed = true; operations?.Invalidate(); lifetime.Cancel(); await health; await recovery;
        await gate.WaitAsync();
        try { foreach (var subscription in subscriptions.Values.ToArray()) await subscription.DisposeAsync(); foreach (var lease in alarmLeases.Values.ToArray()) await lease.DisposeAsync(); alarmLeases.Clear(); subscriptions.Clear(); accessors.Clear(); catalog = null; await driver.DisposeAsync(); }
        finally { gate.Release(); }
    }
}
