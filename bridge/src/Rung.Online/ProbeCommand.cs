// SPDX-License-Identifier: BUSL-1.1
using S7CommPlusDriver;
using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;

namespace Rung.Online;

public sealed record ProbeOptions(string Address, bool PasswordStdin, bool ShowCertificate = false)
{
    public static ProbeOptions Parse(string[] args)
    {
        // Scan the entire invocation before parsing; duplicate options and help cannot bypass the refusal.
        foreach (var argument in args)
        {
            var value = argument[(argument.LastIndexOf('=') + 1)..];
            if (IPAddress.TryParse(value, out var ip) &&
                (ip.IsIPv4MappedToIPv6 ? ip.MapToIPv4() : ip).Equals(IPAddress.Parse("192.168.1.1")))
                throw new ProtectedAddressException();
        }
        if (args.Length == 0 || args[0] != "probe") throw new ArgumentException("Expected probe command.");
        string? address = null;
        var password = false;
        var showCertificate = false;
        for (var i = 1; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--address" when address == null && i + 1 < args.Length:
                    address = args[++i];
                    break;
                case "--password-stdin" when !password:
                    password = true;
                    break;
                case "--show-certificate" when !showCertificate:
                    showCertificate = true;
                    break;
                default:
                    throw new ArgumentException("Unknown, duplicate or incomplete option.");
            }
        }
        if (!IPAddress.TryParse(address, out var target) || target.AddressFamily != AddressFamily.InterNetwork ||
            target.ToString() != address)
            throw new ArgumentException("Address must be a canonical IPv4 literal.");
        return new(address, password, showCertificate);
    }
}

public sealed class ProtectedAddressException : Exception;

public readonly record struct ProbeError(int ExitCode, string Code, string Message)
{
    public static ProbeError From(Exception error) => error switch
    {
        CertificateDiagnosticException diagnostic => diagnostic.Error,
        ProtectedAddressException => new(3, "TARGET_REFUSED", "192.168.1.1 is refused before connection."),
        AuthenticationException => new(4, "CERTIFICATE_UNTRUSTED", "Set RUNG_ONLINE_CERTIFICATE_SHA256 to the independently verified PLC leaf certificate fingerprint."),
        S7CommPlusException { ErrorCode: S7Consts.errS7CommPlusCertificate } => new(4, "CERTIFICATE_UNTRUSTED", "PLC certificate does not match the verified SHA-256 pin. Compare the presented certificate with the TIA Portal project before setting RUNG_ONLINE_CERTIFICATE_SHA256."),
        S7CommPlusLegitimationException => new(5, "AUTHENTICATION_FAILED", "PLC rejected legitimation. Check its password and access settings."),
        S7CommPlusException { ErrorCode: S7Consts.errCliNeedPassword or S7Consts.errCliInvalidPassword } => new(5, "AUTHENTICATION_FAILED", "PLC requires a valid password. Use --password-stdin."),
        S7CommPlusException { ErrorCode: S7Consts.errOpenSSL or S7Consts.errInitSslResponse } => new(6, "TLS_FAILED", "Secure communication failed. Check PLC firmware and TLS configuration."),
        OperationCanceledException or TimeoutException or S7CommPlusTimeoutException => new(7, "TIMEOUT", "Probe was cancelled or timed out."),
        S7CommPlusException { ErrorCode: S7Consts.errCliAccessDenied } => new(9, "ACCESS_DENIED", "PLC denied read access."),
        S7CommPlusException => new(8, "CONNECTION_FAILED", "PLC communication or read failed."),
        ArgumentException => new(2, "USAGE", "Usage: rung-online probe --address <ip> [--password-stdin] [--show-certificate]"),
        _ => new(1, "FAILED", "Probe failed.")
    };
}

public static class ProbeCommand
{
    public static async Task<int> RunAsync(string[] args, TextReader input, TextWriter output, TextWriter error,
        Func<string?> certificatePin, Func<ProbeOptions, string, string, CancellationToken, Task> probe,
        CancellationToken cancellationToken = default,
        Func<ProbeOptions, CancellationToken, Task<byte[]?>>? inspect = null)
    {
        try
        {
            var options = ProbeOptions.Parse(args);
            if (options.ShowCertificate)
            {
                var leaf = await (inspect ?? Probe.InspectAsync)(options, cancellationToken);
                await output.WriteLineAsync(CertificateDiagnostics.Format(leaf));
                return leaf == null ? 6 : 0;
            }
            var pin = certificatePin();
            if (pin == null || pin.Length != 64 || !pin.All(Uri.IsHexDigit))
            {
                var leaf = await (inspect ?? Probe.InspectAsync)(options, cancellationToken);
                throw new CertificateDiagnosticException(ProbeError.From(new AuthenticationException()), leaf);
            }
            var password = options.PasswordStdin
                ? await input.ReadLineAsync(cancellationToken) ?? throw new ArgumentException("Password input is missing.")
                : "";
            await probe(options, password, pin, cancellationToken);
            return 0;
        }
        catch (Exception ex)
        {
            var failure = ProbeError.From(ex);
            await error.WriteLineAsync($"{failure.Code}: {failure.Message}");
            return failure.ExitCode;
        }
    }
}
