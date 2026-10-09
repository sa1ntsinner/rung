// SPDX-License-Identifier: LGPL-3.0-or-later
using System;
using System.Threading;
using System.Threading.Tasks;

namespace S7CommPlusDriver;

/// <summary>Inspects TLS only. Always disconnects before PLC session creation or legitimation.</summary>
public static class S7CommPlusCertificateProbe
{
    public static async Task InspectAsync(S7CommPlusClientOptions options, CancellationToken cancellationToken = default)
    {
        var settings = options.Clone();
        settings.Validate();
        cancellationToken.ThrowIfCancellationRequested();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(settings.ConnectTimeout);
        try
        {
            await Task.Run(() =>
            {
                var session = new S7CommPlusProtocolSession();
                try
                {
                    var result = session.InspectCertificate(settings, deadline.Token);
                    deadline.Token.ThrowIfCancellationRequested();
                    if (result is S7Consts.errTCPConnectionTimeout or S7Consts.errTCPReceiveTimeout or S7Consts.errTCPSendTimeout or S7Consts.errCliJobTimeout)
                        throw new TimeoutException("PLC TLS certificate inspection timed out.");
                    if (result != 0)
                        throw new S7CommPlusConnectionException("InspectCertificate", settings.Address, result, false,
                            "PLC TLS certificate inspection failed.");
                }
                finally
                {
                    session.CloseTransport(settings.DisconnectTimeoutMilliseconds);
                }
            }, deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("PLC TLS certificate inspection timed out.");
        }
    }
}
