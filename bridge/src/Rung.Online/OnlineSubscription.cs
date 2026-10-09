// SPDX-License-Identifier: BUSL-1.1
namespace Rung.Online;

internal sealed class OnlineSubscription(string[] names, OnlineReadItem[] rows, int cycleMs) : IAsyncDisposable
{
    public readonly string Id = Guid.NewGuid().ToString("N");
    public readonly string[] Names = names;
    public readonly int CycleMs = cycleMs;
    public OnlineReadItem[] Snapshot = rows;
    public IAsyncDisposable? Lease;
    public long Generation;
    public bool Disposed;
    public void Merge(OnlineReadItem[] delta, IReadOnlyDictionary<string, string> aliases) {
        var byName = delta.ToDictionary(r => Symbols.Normalize(r.Name), StringComparer.Ordinal);
        Snapshot = Snapshot.Select(row => row.ErrorCode != "BAD_REQUEST" && aliases.TryGetValue(Symbols.Normalize(row.Name), out var name) && byName.TryGetValue(name, out var update) ? update with { Name = row.Name } : row).ToArray();
    }
    public async ValueTask DisposeAsync() {
        lock (this) { if (Disposed) return; Disposed = true; Generation++; }
        if (Lease != null) await Lease.DisposeAsync();
    }
}
