// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using Rung.Bridge.Core;
using Xunit;

/// <summary>Receipts of committed imports, asked for by a rung that was stopped before it heard the answer.</summary>
[Collection("receipts")]
public class ReceiptsTests
{
    [Fact]
    public void AnImportWithAReceiptLandedOneWithoutDidNot()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rung-receipts-" + Guid.NewGuid().ToString("N"));
        var before = Environment.GetEnvironmentVariable("RUNG_RECEIPTS_DIR");
        Environment.SetEnvironmentVariable("RUNG_RECEIPTS_DIR", dir);
        try
        {
            var landed = Guid.NewGuid().ToString("D");
            var lost = Guid.NewGuid().ToString("D");
            Receipts.Write(landed, "plc:PLC_1/blocks/Fx_A");
            Assert.Equal(new[] { landed }, Receipts.Landed(new[] { lost, landed }));
            // committed and then put back: not landed
            Receipts.Remove(landed);
            Assert.Empty(Receipts.Landed(new[] { landed }));
            Receipts.Remove(lost);
            // not an operation id: never a path
            Receipts.Write("..\\escape", "x");
            Assert.Empty(Receipts.Landed(new[] { "..\\escape", "" }));
            Assert.False(File.Exists(Path.Combine(dir, "..", "escape")));
        }
        finally
        {
            Environment.SetEnvironmentVariable("RUNG_RECEIPTS_DIR", before);
            try { Directory.Delete(dir, true); } catch (IOException) { }
        }
    }
}
