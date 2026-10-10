// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using S7CommPlusDriver;
using Xunit;

public sealed class CpuSettleTests
{
    [Fact]
    public async Task ReportsTheModeTheCpuReachesNotTheOneItLeaves()
    {
        var seen = new Queue<S7CommPlusCpuOperatingState>([S7CommPlusCpuOperatingState.Run, S7CommPlusCpuOperatingState.Run, S7CommPlusCpuOperatingState.Stop]);
        var reads = 0;
        var state = await CpuSettle.WaitAsync(() => { reads++; return Task.FromResult(seen.Dequeue()); }, S7CommPlusCpuOperatingState.Stop, TimeSpan.FromSeconds(5), TimeSpan.Zero, CancellationToken.None);
        Assert.Equal(S7CommPlusCpuOperatingState.Stop, state);
        Assert.Equal(3, reads);
    }

    [Fact]
    public async Task GivesTheLastModeSeenWhenTheCpuDoesNotGetThere()
    {
        var state = await CpuSettle.WaitAsync(() => Task.FromResult(S7CommPlusCpuOperatingState.Startup), S7CommPlusCpuOperatingState.Run, TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(10), CancellationToken.None);
        Assert.Equal(S7CommPlusCpuOperatingState.Startup, state);
    }
}
