// SPDX-License-Identifier: BUSL-1.1
using System.Globalization;
using Rung.Online;
using Rung.Bridge.Core.Protocol;
using Xunit;

public sealed class WritePolicyTests
{
    [Theory]
    [InlineData(1u, "BOOL#TRUE", "True")]
    [InlineData(40u, "BOOL#TRUE", "True")]
    [InlineData(40u, "FALSE", "False")]
    [InlineData(5u, "INT#-32768", "-32768")]
    [InlineData(53u, "UINT#65535", "65535")]
    [InlineData(49u, "ULINT#18446744073709551615", "18446744073709551615")]
    [InlineData(50u, "LINT#-9223372036854775808", "-9223372036854775808")]
    [InlineData(4u, "WORD#16#FFFF", "65535")]
    [InlineData(8u, "REAL#1.5", "1.5")]
    [InlineData(48u, "LREAL#1.5E100", "1.5E+100")]
    [InlineData(11u, "T#1s500ms", "1500")]
    [InlineData(64u, "LT#1us1ns", "1001")]
    public void ParsesScalarLiteralsWithoutOverflowOrPrecisionLoss(uint type, string literal, string expected)
    {
        Assert.Equal(expected, Convert.ToString(WritePolicy.ParseScalar(type, literal), CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData(1u, "1")]
    [InlineData(5u, "32768")]
    [InlineData(53u, "-1")]
    [InlineData(49u, "18446744073709551616")]
    [InlineData(7u, "REAL#1.0")]
    [InlineData(8u, "1e50")]
    [InlineData(8u, "1e-50")]
    [InlineData(48u, "NaN")]
    [InlineData(48u, "1e-500")]
    [InlineData(11u, "T#1sJUNK")]
    [InlineData(11u, "T#1ns")]
    [InlineData(11u, "T#1ms1s")]
    [InlineData(7u, "1__2")]
    public void RefusesInvalidOrOutOfRangeValues(uint type, string literal) =>
        Assert.Equal(ErrorCodes.BadRequest, Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(type, literal)).Code);

    [Fact]
    public void StringsRequireKnownCapacityAndDoNotTruncateOrReplaceCharacters()
    {
        Assert.Equal("a'b\n", WritePolicy.ParseScalar(19, "'a$'b$N'", 4));
        Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(19, "'four'", 3));
        Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(19, "'text'"));
        Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(19, "'🙂'", 8));
        Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(19, "'bad$Z'", 8));
    }

    [Fact]
    public void WideStringsUseFourDigitEscapesAndRejectInvalidUnicode()
    {
        Assert.Equal("AΩ", WritePolicy.ParseScalar(62, "WSTRING#'$0041$03A9'", 2));
        Assert.Throws<RpcException>(() => WritePolicy.ParseScalar(62, "'$D800'", 8));
    }
}
