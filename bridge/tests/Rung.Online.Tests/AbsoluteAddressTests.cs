// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver;
using Xunit;

public sealed class AbsoluteAddressTests
{
    [Fact]
    public void ArrayReshapeInvalidatesCatalogueAndPreparedProgramRevision()
    {
        var variable = new VarInfo { Name = "DB.Values", Softdatatype = 5, ArrayElementCount = 12,
            ArrayDimensions = [new S7CommPlusArrayDimension(0, 2), new S7CommPlusArrayDimension(0, 6)] };
        var flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
        var symbols = typeof(OnlineSession).Assembly.GetType("Rung.Online.OnlineDriver")!.GetMethod("SymbolRecords", flags)!;
        OnlineSymbol[] Catalogue() => (OnlineSymbol[])symbols.Invoke(null, new object[] { new[] { variable } })!;
        var revision = typeof(OnlineSession).GetMethod("ProgramRevision", flags)!;
        var before = Catalogue();
        variable.ArrayDimensions = [new S7CommPlusArrayDimension(0, 3), new S7CommPlusArrayDimension(0, 4)];
        var after = Catalogue();
        Assert.NotEqual(before[0], after[0]);
        Assert.NotEqual(revision.Invoke(null, new object[] { before }), revision.Invoke(null, new object[] { after }));
    }
    [Theory]
    [InlineData("50.1", 1u, 2u, 3, "%I2.3")]
    [InlineData("51.1", 2u, 4u, 0, "%QB4")]
    [InlineData("52.1", 4u, 6u, 0, "%MW6")]
    [InlineData("52.1", 6u, 8u, 0, "%MD8")]
    [InlineData("8A0E0001.1", 4u, 6u, 0, null)]
    [InlineData("52.1", 5u, 6u, 0, null)]
    public void OnlyExplicitIoMetadataAndMatchingUnsignedTypesMap(string access, uint type, uint offset, int bit, string? expected)
    {
        Assert.Equal(expected, AbsoluteAddress.FromMetadata(new VarInfo {
            Name = "Tag", AccessSequence = access, Softdatatype = type, NonOptAddress = offset, NonOptBitoffset = bit,
        }));
    }

    [Fact]
    public void ResolvesAliasesButRefusesOverlapsAndUnmappedDbOffsets()
    {
        var symbol = new OnlineSymbol("Input", 1, true, 0, AbsoluteAddress: "%I2.3");
        Assert.Equal(symbol, Symbols.Resolve("%i2.3", [symbol]));
        Assert.Equal(ErrorCodes.SymbolAmbiguous, Assert.Throws<RpcException>(() => Symbols.Resolve("%I2.3", [symbol, symbol with { Name = "Other" }])).Code);
        Assert.Equal(ErrorCodes.UnsupportedObject, Assert.Throws<RpcException>(() => Symbols.Resolve("%DB1.DBW0", [symbol])).Code);
    }

    [Fact]
    public void FindsAPlcTagByItsNameInTheInputOutputAndMemoryAreas()
    {
        var input = new OnlineSymbol("IArea.Start_PB", 1, true, 0, AbsoluteAddress: "%I0.0");
        var db = new OnlineSymbol("Line_DB.Speed", 5, true, 0);
        Assert.Equal(input, Symbols.Resolve("\"Start_PB\"", [input, db]));
        Assert.Equal(input, Symbols.Resolve("Start_PB", [input, db]));
        Assert.Equal(db, Symbols.Resolve("\"Line_DB\".Speed", [input, db]));
        Assert.Equal(ErrorCodes.SymbolAmbiguous, Assert.Throws<RpcException>(() => Symbols.Resolve("\"Start_PB\"", [input, input with { Name = "MArea.Start_PB" }])).Code);
    }

    [Fact]
    public void SaysWhatToDoWhenNoTagIsAtTheAddress()
    {
        var refused = Assert.Throws<RpcException>(() => Symbols.Resolve("%mw100", [new OnlineSymbol("Input", 1, true, 0, AbsoluteAddress: "%I2.3")]));
        Assert.Contains("No PLC tag is at %MW100", refused.Message);
        Assert.Contains("tag table", refused.Message);
    }
}
