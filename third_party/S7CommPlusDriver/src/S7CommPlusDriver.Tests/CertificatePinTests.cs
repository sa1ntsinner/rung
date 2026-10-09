using System;
using System.Security.Authentication;
using System.Security.Cryptography;
using S7CommPlusDriver.Tls;
using Xunit;

namespace S7CommPlusDriver.Tests;

public sealed class CertificatePinTests
{
    [Fact]
    public void VerifiedPinAcceptsOnlyMatchingCertificate()
    {
        var certificate = new byte[] { 1, 2, 3 };
        var pin = Convert.ToHexString(SHA256.HashData(certificate));
        CertificatePin.Validate(certificate, pin.ToLowerInvariant());
        Assert.Throws<AuthenticationException>(() => CertificatePin.Validate(new byte[] { 1, 2, 4 }, pin));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("00")]
    [InlineData("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")]
    public void UnknownOrMalformedPinFailsClosed(string? pin)
        => Assert.Throws<AuthenticationException>(() => CertificatePin.Validate(new byte[] { 1 }, pin));
}
