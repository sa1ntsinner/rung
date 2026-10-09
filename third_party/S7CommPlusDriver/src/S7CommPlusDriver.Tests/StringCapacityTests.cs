using S7CommPlusDriver.ClientApi;
using Xunit;

namespace S7CommPlusDriver.Tests;

public sealed class StringCapacityTests
{
    [Fact]
    public void StringWritesKeepThePlcReportedCapacityAndRejectOverflow()
    {
        var tag = new PlcTagString("DB.Text", null, Softdatatype.S7COMMP_SOFTDATATYPE_STRING);
        tag.ProcessReadResult(new ValueUSIntArray(new byte[] { 3, 1, 65 }), 0);
        Assert.Equal(3, tag.MaxLength);
        Assert.Throws<System.ArgumentOutOfRangeException>(() => tag.Value = "four");
        tag.Value = "ab";
        var wire = Assert.IsType<ValueUSIntArray>(tag.GetWriteValue()).GetValue();
        Assert.Equal(new byte[] { 3, 2, 97, 98, 0 }, wire);
    }

    [Fact]
    public void WStringWritesKeepCapacityAndMalformedReadHeadersHaveBadQuality()
    {
        var tag = new PlcTagWString("DB.Text", null, Softdatatype.S7COMMP_SOFTDATATYPE_WSTRING);
        tag.ProcessReadResult(new ValueUIntArray(new ushort[] { 3, 1, 65 }), 0);
        Assert.Equal(3, tag.MaxLength);
        Assert.Throws<System.ArgumentOutOfRangeException>(() => tag.Value = "four");
        tag.Value = "ab";
        var wire = Assert.IsType<ValueUIntArray>(tag.GetWriteValue()).GetValue();
        Assert.Equal(new ushort[] { 3, 2, 97, 98, 0 }, wire);
        tag.ProcessReadResult(new ValueUIntArray(new ushort[] { 1, 2, 65 }), 0);
        Assert.Equal(PlcTagQC.TAG_QUALITY_BAD, tag.Quality);
    }
}
