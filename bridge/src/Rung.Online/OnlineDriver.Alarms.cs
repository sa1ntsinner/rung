// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;

namespace Rung.Online;

internal sealed partial class OnlineDriver
{
    public async Task<OnlineAlarm[]> AlarmsAsync(int lcid, CancellationToken token) =>
        (await client.GetActiveAlarmsAsync(token)).Select(a => Alarms.Normalize(a, lcid, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())).ToArray();

    public async Task<IAsyncDisposable> SubscribeAlarmsAsync(int lcid, Action<OnlineAlarm[], bool> notify, Action<Exception> fail, CancellationToken token) {
        await using var snapshot = new S7CommPlusClient(Options(target));
        await snapshot.ConnectAsync(token);
        var expected = await client.GetCpuInfoAsync(token); var actual = await snapshot.GetCpuInfoAsync(token);
        if (expected.CpuMlfb != actual.CpuMlfb || expected.CpuSerial != actual.CpuSerial || expected.PlcName != actual.PlcName || expected.CpuFirmware?.ToString() != actual.CpuFirmware?.ToString())
            throw new RpcException(ErrorCodes.TargetRefused, "Alarm snapshot PLC identity differs.");
        var lease = await client.SubscribeAlarmsWithSnapshotAsync(snapshot, Array.Empty<int>(), lcid,
            new S7CommPlusSubscriptionOptions { MaxConsecutiveTimeoutsBeforeFault = 0 }, token);
        try {
            notify(lease.ActiveAlarms.Select(a => Alarms.Normalize(a, lcid, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())).ToArray(), true);
            lease.Subscription.NotificationReceived += (_, args) => {
                try {
                    if (!args.Notification.IsSuccess) throw new IOException("Alarm notification failed.");
                    var at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    notify(args.Notification.Alarms.Select(a => Alarms.Normalize(a, lcid, at)).ToArray(), false);
                } catch (Exception error) { fail(error); }
            };
            lease.Subscription.CommunicationError += (_, args) => fail(args.Exception);
            return lease;
        } catch { await lease.DisposeAsync(); throw; }
    }
}
