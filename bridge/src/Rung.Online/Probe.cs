// SPDX-License-Identifier: BUSL-1.1
using S7CommPlusDriver;
using S7CommPlusDriver.ClientApi;
using System.Text.Json;

namespace Rung.Online;

internal static class Probe
{
    internal static async Task<byte[]?> InspectAsync(ProbeOptions options, CancellationToken token)
    {
        byte[]? leaf = null;
        try
        {
            await S7CommPlusCertificateProbe.InspectAsync(new S7CommPlusClientOptions
            {
                Address = options.Address,
                CertificateReceived = certificate => leaf = certificate,
                AutoReconnect = false,
                WriteEnabled = false
            }, token);
            return leaf;
        }
        catch (S7CommPlusException ex)
        {
            throw new CertificateDiagnosticException(ProbeError.From(ex), leaf);
        }
        catch (TimeoutException ex)
        {
            throw new CertificateDiagnosticException(ProbeError.From(ex), leaf);
        }
    }

    private static bool IsCertificateOrTlsFailure(S7CommPlusException ex) =>
        ex.ErrorCode is S7Consts.errS7CommPlusCertificate or S7Consts.errOpenSSL or S7Consts.errInitSslResponse;

    internal static async Task RunAsync(ProbeOptions options, string password, string pin, TextWriter output, CancellationToken token)
    {
        byte[]? leaf = null;
        await using var client = new S7CommPlusClient(new S7CommPlusClientOptions
        {
            Address = options.Address,
            Password = password,
            CertificateSha256 = pin,
            CertificateReceived = certificate => leaf = certificate,
            SecurityMode = S7CommPlusSecurityMode.Tls,
            TlsBackend = S7CommPlusTlsBackend.BouncyCastle,
            AutoReconnect = false,
            WriteEnabled = false
        });
        try
        {
            await client.ConnectAsync(token);
        }
        catch (S7CommPlusException ex) when (leaf == null || IsCertificateOrTlsFailure(ex))
        {
            throw new CertificateDiagnosticException(ProbeError.From(ex), leaf);
        }
        await output.WriteLineAsync($"Security: TLS 1.3 ({client.Options.NegotiatedSecurityMode})");
        var cpu = await client.GetCpuInfoAsync(token);
        var state = await client.GetCpuStateAsync(token);
        await output.WriteLineAsync($"CPU type: {JsonSerializer.Serialize(cpu.CpuMlfb)}; firmware: {cpu.CpuFirmware}; operating state: {state.OperatingState}");
        var variables = await client.BrowseAsync(token);
        var candidates = variables.Where(v => v.ArrayElementCount == 0 && v.HmiAccessible)
            .OrderBy(v => v.Name.StartsWith("DB", StringComparison.Ordinal) ? 0 : 1).Take(5).ToArray();
        foreach (var variable in candidates)
            await output.WriteLineAsync($"Symbol: {JsonSerializer.Serialize(variable.Name)}; datatype: {variable.Softdatatype}");
        var tags = await client.GetTagsBySymbolsAsync(candidates.Select(v => v.Name), token);
        var tag = tags.Values.FirstOrDefault() ?? throw new S7CommPlusConnectionException(
            "Browse", options.Address, S7Consts.errCliItemNotAvailable, false, "No readable scalar symbols found.");
        var result = await client.ReadAsync(new[] { tag.Address }, token);
        var item = result.Items.Single();
        if (!item.IsSuccess)
            throw new S7CommPlusConnectionException("Read", options.Address,
                item.ItemError == 0x13 ? S7Consts.errCliAccessDenied : S7Consts.errCliItemNotAvailable, false, "Symbol read was rejected.");
        await output.WriteLineAsync($"Read {JsonSerializer.Serialize(tag.Name)}: {JsonSerializer.Serialize(item.Value?.ToString())}");
        await client.DisconnectAsync(token);
    }
}
