// SPDX-License-Identifier: BUSL-1.1
using S7CommPlusDriver;

namespace Rung.Online;

/// <summary>A CPU told to RUN or STOP passes through Startup or stays in its old mode for a moment: ask until it arrives.</summary>
public static class CpuSettle
{
    public static async Task<S7CommPlusCpuOperatingState> WaitAsync(Func<Task<S7CommPlusCpuOperatingState>> read, S7CommPlusCpuOperatingState want, TimeSpan budget, TimeSpan pause, CancellationToken token)
    {
        var until = DateTime.UtcNow + budget;
        while (true) {
            var state = await read();
            if (state == want || DateTime.UtcNow >= until) return state;
            await Task.Delay(pause, token);
        }
    }
}
