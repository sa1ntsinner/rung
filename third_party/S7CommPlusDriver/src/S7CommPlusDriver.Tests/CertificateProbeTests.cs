using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace S7CommPlusDriver.Tests;

public sealed class CertificateProbeTests
{
    [Fact]
    public async Task PreCancelledInspectionNeverObservesCertificate()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => S7CommPlusCertificateProbe.InspectAsync(
            new S7CommPlusClientOptions { Address = "127.0.0.1", CertificateReceived = _ => throw new Exception("Must not handshake") },
            cancelled.Token));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InterruptedInspectionClosesTransportWithoutCredentials(bool timeout)
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var cancelled = new CancellationTokenSource();
        var pending = S7CommPlusCertificateProbe.InspectAsync(new S7CommPlusClientOptions
        {
            Address = "127.0.0.1",
            Port = ((IPEndPoint)listener.LocalEndpoint).Port,
            ConnectTimeout = TimeSpan.FromSeconds(timeout ? 1 : 5),
            Password = "must-not-be-sent",
            CertificateReceived = _ => throw new Exception("Server does not offer TLS")
        }, cancelled.Token);
        using var peer = await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(5));
        var stream = peer.GetStream();
        var header = new byte[4];
        await stream.ReadExactlyAsync(header);
        var request = new byte[(header[2] << 8 | header[3]) - 4];
        await stream.ReadExactlyAsync(request);
        Assert.Equal(0xE0, request[1]); // Only COTP connection negotiation was sent.
        if (!timeout) cancelled.Cancel();
        if (timeout)
            await Assert.ThrowsAsync<TimeoutException>(() => pending);
        else
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        try
        {
            Assert.Equal(0, await stream.ReadAsync(new byte[1]).AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
        }
        catch (IOException ex) when (ex.InnerException is SocketException { SocketErrorCode: SocketError.ConnectionReset })
        {
            // The driver closes aborted transports with a reset on Windows.
        }
    }
}
