// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;

namespace Rung.Online;

public sealed partial class OnlineSession
{
    sealed class AlarmLease(int lcid) : IAsyncDisposable {
        public readonly string Id = Guid.NewGuid().ToString("N");
        public readonly int Lcid = lcid;
        public readonly AlarmSet Rows = new();
        public IAsyncDisposable? Lease;
        public int Generation;
        public bool Disposed;
        public async ValueTask DisposeAsync() { lock (this) { Disposed = true; Generation++; } if (Lease != null) await Lease.DisposeAsync(); Lease = null; }
    }
    readonly Dictionary<string, AlarmLease> alarmLeases = new();
    public event Action<object>? AlarmsChanged;
    int LeaseCount => subscriptions.Count + alarmLeases.Count;
    object AlarmFrame(AlarmLease lease, string state = "connected", string? errorCode = null) {
        lock (lease) return new { sessionId = Info.SessionId, subscriptionId = lease.Id,
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = Info.Scope, lcid = lease.Lcid, alarms = lease.Rows.Snapshot, connectionState = state, errorCode };
    }

    public async Task<object> AlarmsAsync(int lcid, bool subscribe, CancellationToken token) {
        if (lcid is < 1 or > 65535) throw new RpcException(ErrorCodes.BadRequest, "LCID must be 1..65535.");
        await gate.WaitAsync(token);
        try {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (disconnected || terminal || recovering != 0) throw new RpcException(ErrorCodes.OnlineFailed, "Session is disconnected or recovering.");
            if (!subscribe) return new { at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope = Info.Scope, lcid, alarms = await driver.AlarmsAsync(lcid, token), connectionState = "connected" };
            if (alarmLeases.Count >= 8) throw new RpcException(ErrorCodes.ResourceLimit, "At most 8 alarm leases.");
            var lease = new AlarmLease(lcid); alarmLeases.Add(lease.Id, lease);
            try { await StartAlarmLeaseAsync(lease, token); }
            catch { alarmLeases.Remove(lease.Id); await lease.DisposeAsync(); throw; }
            if (health == Task.CompletedTask) health = Task.Run(HealthLoopAsync);
            return new { subscriptionId = lease.Id, snapshot = AlarmFrame(lease) };
        } finally { gate.Release(); }
    }
    async Task StartAlarmLeaseAsync(AlarmLease lease, CancellationToken token) {
        var generation = ++lease.Generation;
        lease.Lease = await driver.SubscribeAlarmsAsync(lease.Lcid, (rows, reset) => {
            lock (lease) {
                if (disposed || lease.Disposed || lease.Generation != generation) return;
                if (reset) lease.Rows.Clear(); lease.Rows.Merge(rows);
                if (recovering == 0) AlarmsChanged?.Invoke(AlarmFrame(lease));
            }
        }, error => { lock (lease) { if (!lease.Disposed && lease.Generation == generation) BeginRecovery(error); } }, token);
    }
}
