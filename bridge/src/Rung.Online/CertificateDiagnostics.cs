// SPDX-License-Identifier: BUSL-1.1
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Rung.Online;

public static class CertificateDiagnostics
{
    public static string Format(byte[]? leaf)
    {
        if (leaf == null)
            return "No certificate was presented: the PLC did not negotiate TLS. Likely causes include a PLC without secure PG/PC communication enabled or older firmware without TLS support. If connection establishment failed, also check the address, network reachability and port 102.";
        using var certificate = X509CertificateLoader.LoadCertificate(leaf);
        // Escape control characters in peer-controlled names so they cannot forge console lines.
        static string Name(string value) => JsonSerializer.Serialize(value)[1..^1];
        return $"PLC leaf certificate (unverified; compare with the certificate in the TIA Portal project):{Environment.NewLine}" +
            $"Subject: {Name(certificate.Subject)}{Environment.NewLine}" +
            $"Issuer: {Name(certificate.Issuer)}{Environment.NewLine}" +
            $"Valid from (UTC): {certificate.NotBefore.ToUniversalTime():yyyy-MM-ddTHH:mm:ssZ}{Environment.NewLine}" +
            $"Valid until (UTC): {certificate.NotAfter.ToUniversalTime():yyyy-MM-ddTHH:mm:ssZ}{Environment.NewLine}" +
            $"SHA-256: {Convert.ToHexString(SHA256.HashData(leaf))}{Environment.NewLine}" +
            $"SHA-1: {Convert.ToHexString(SHA1.HashData(leaf))}";
    }
}

public sealed class CertificateDiagnosticException(ProbeError error, byte[]? leaf) : Exception
{
    public ProbeError Error { get; } = error with
    {
        Message = (leaf == null && error.Code == "CERTIFICATE_UNTRUSTED"
            ? "No PLC certificate was presented; certificate trust cannot be verified."
            : error.Message) + Environment.NewLine + CertificateDiagnostics.Format(leaf)
    };
}
