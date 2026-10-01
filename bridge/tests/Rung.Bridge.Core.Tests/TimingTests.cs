// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using Rung.Bridge.Core;
using Xunit;

/// <summary>Phase timings for measuring large projects: one line per operation, and nothing at all when off.</summary>
public class TimingTests
{
    [Fact]
    public void WritesOneLinePerOperationWithEveryPhase()
    {
        var file = Path.Combine(Path.GetTempPath(), "rung-timing-" + Guid.NewGuid().ToString("N") + ".log");
        try
        {
            var t = new Timing(file);
            t.Lap("check");
            t.Lap("import");
            t.Done("import plc:PLC_1/blocks/Fx_A");
            var lines = File.ReadAllLines(file);
            Assert.Single(lines);
            Assert.Matches(@" import plc:PLC_1/blocks/Fx_A check=\d+ms import=\d+ms$", lines[0]);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void WritesNothingWhenOff()
    {
        var t = new Timing((string)null);
        t.Lap("check");
        t.Done("import plc:PLC_1/blocks/Fx_A");
        var empty = new Timing("");
        empty.Done("x");
    }
}
