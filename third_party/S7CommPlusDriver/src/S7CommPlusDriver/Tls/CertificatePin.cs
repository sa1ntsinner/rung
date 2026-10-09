// SPDX-License-Identifier: LGPL-3.0-or-later
using System;
using System.Security.Authentication;
using System.Security.Cryptography;

namespace S7CommPlusDriver.Tls;

internal static class CertificatePin
{
    internal static void Validate(byte[] certificate, string pin)
    {
        if (string.IsNullOrEmpty(pin) || pin.Length != 64)
            throw new AuthenticationException("A verified PLC certificate SHA-256 pin is required.");
        byte[] expected;
        try { expected = Convert.FromHexString(pin); }
        catch (FormatException ex) { throw new AuthenticationException("Invalid PLC certificate SHA-256 pin.", ex); }
        if (certificate == null || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(certificate), expected))
            throw new AuthenticationException("PLC certificate SHA-256 pin mismatch.");
    }
}
