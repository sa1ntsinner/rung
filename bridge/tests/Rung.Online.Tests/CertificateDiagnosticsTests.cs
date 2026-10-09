// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Xunit;

namespace Rung.Online.Tests;

public sealed class CertificateDiagnosticsTests
{
    [Fact]
    public void FormatsLeafIdentityUtcValidityAndBothFingerprints()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=PLCSIM", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var certificate = request.CreateSelfSigned(
            new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero),
            new DateTimeOffset(2027, 2, 3, 4, 5, 6, TimeSpan.Zero));
        var der = certificate.Export(X509ContentType.Cert);
        var text = CertificateDiagnostics.Format(der);
        Assert.Contains("Subject: CN=PLCSIM", text);
        Assert.Contains("Issuer: CN=PLCSIM", text);
        Assert.Contains("2026-01-02T03:04:05Z", text);
        Assert.Contains("2027-02-03T04:05:06Z", text);
        Assert.Contains("SHA-256: " + Convert.ToHexString(SHA256.HashData(der)), text);
        Assert.Contains("SHA-1: " + Convert.ToHexString(SHA1.HashData(der)), text);
        Assert.Contains("TIA Portal", text);
        Assert.Contains("unverified", text);
    }

    [Fact]
    public void MissingCertificateExplainsTlsAndLikelyConfigurationCauses()
    {
        var text = CertificateDiagnostics.Format(null);
        Assert.Contains("No certificate was presented", text);
        Assert.Contains("did not negotiate TLS", text);
        Assert.Contains("secure PG/PC", text);
        Assert.Contains("older firmware", text);
        Assert.DoesNotContain("SHA-256:", text);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PresentedCertificateIsPrintedWithoutStartingUnpinnedSession(bool showCertificate)
    {
        using var key = RSA.Create(2048);
        using var certificate = new CertificateRequest("CN=PLC", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var der = certificate.Export(X509ContentType.Cert);
        using var output = new StringWriter();
        using var error = new StringWriter();
        var args = new List<string> { "probe", "--address", "192.168.250.1", "--password-stdin" };
        if (showCertificate) args.Add("--show-certificate");
        var exit = await ProbeCommand.RunAsync(args.ToArray(), new UnreadableInput(), output, error,
            () => null, (_, _, _, _) => throw new Exception("Must not start a PLC session"),
            inspect: (_, _) => Task.FromResult<byte[]?>(der));
        Assert.Equal(showCertificate ? 0 : 4, exit);
        Assert.Contains("Subject: CN=PLC", showCertificate ? output.ToString() : error.ToString());
        Assert.Contains(Convert.ToHexString(SHA256.HashData(der)), showCertificate ? output.ToString() : error.ToString());
    }

    [Fact]
    public void PinMismatchKeepsTrustFailureAndCertificateDiagnostics()
    {
        using var key = RSA.Create(2048);
        using var certificate = new CertificateRequest("CN=WrongPLC", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var rejection = new S7CommPlusDriver.S7CommPlusConnectionException("Connect", "endpoint",
            S7CommPlusDriver.S7Consts.errS7CommPlusCertificate, false, "pin mismatch");
        var error = ProbeError.From(new CertificateDiagnosticException(ProbeError.From(rejection), certificate.RawData));
        Assert.Equal(4, error.ExitCode);
        Assert.Equal("CERTIFICATE_UNTRUSTED", error.Code);
        Assert.Contains("Subject: CN=WrongPLC", error.Message);
        Assert.Contains("does not match", error.Message);
    }

    private sealed class UnreadableInput : TextReader
    {
        public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken) =>
            throw new Exception("Must not read a password");
    }
}
