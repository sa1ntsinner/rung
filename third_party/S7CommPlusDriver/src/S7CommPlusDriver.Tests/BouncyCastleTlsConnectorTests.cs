using Org.BouncyCastle.Asn1.X509;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Operators;
using Org.BouncyCastle.Math;
using Org.BouncyCastle.Security;
using Org.BouncyCastle.Tls;
using Org.BouncyCastle.Tls.Crypto;
using Org.BouncyCastle.Tls.Crypto.Impl.BC;
using Org.BouncyCastle.X509;
using S7CommPlusDriver.Tls;
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Xunit;
using TlsCertificate = Org.BouncyCastle.Tls.Certificate;
using TlsProtocolVersion = Org.BouncyCastle.Tls.ProtocolVersion;

namespace S7CommPlusDriver.Tests
{
    public sealed class BouncyCastleTlsConnectorTests
    {
        private const string OmsExporterLabel = "EXPERIMENTAL_OMS";
        private const int OmsExporterSecretLength = 32;

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task CancellationBeforeOrDuringTlsSetupCannotLeaveHandshakeBlocked(bool beforeSetup)
        {
            using var cancellation = new CancellationTokenSource();
            using var connector = new BouncyCastleTlsConnector(new CancellingCallback(cancellation));
            if (beforeSetup) cancellation.Cancel();
            var handshake = Task.Run(() => connector.StartHandshake(cancellation.Token));
            var error = await Record.ExceptionAsync(() => handshake.WaitAsync(TimeSpan.FromSeconds(2)));
            Assert.NotNull(error);
            Assert.IsNotType<TimeoutException>(error);
            Assert.Throws<InvalidOperationException>(() => connector.GetOmsExporterSecret());
        }

        private sealed class CancellingCallback(CancellationTokenSource cancellation) : IS7TlsConnectorCallback
        {
            public void WriteData(byte[] data, int dataLength) => cancellation.Cancel();
            public void OnDataAvailable() { }
            public void OnSslError(int sslError, string sslState) { }
        }

        [Fact]
        public async Task CertificateInspectionCompletesTlsAndSendsNoPlcSessionData()
        {
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var server = new ExporterTlsServer();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var applicationBytes = -1;
            var serving = Task.Run(async () =>
            {
                using var peer = await listener.AcceptTcpClientAsync(deadline.Token);
                var wire = peer.GetStream();
                async Task<byte[]> Packet()
                {
                    var header = new byte[7];
                    await wire.ReadExactlyAsync(header, deadline.Token);
                    var payload = new byte[(header[2] << 8 | header[3]) - 7];
                    await wire.ReadExactlyAsync(payload, deadline.Token);
                    return payload;
                }
                void Send(byte[] payload, int offset, int count)
                {
                    var length = count + 7;
                    wire.Write(new byte[] { 3, 0, (byte)(length >> 8), (byte)length, 2, 0xF0, 0x80 });
                    wire.Write(payload, offset, count);
                }
                await Packet(); // COTP request.
                wire.Write(new byte[] { 3, 0, 0, 14, 9, 0xD0, 0, 0, 0, 1, 0, 0xC0, 1, 10 });
                var init = await Packet();
                Assert.Equal(0xB3, init[8]); // InitSSL only.
                var response = new byte[] { 0x72, 1, 0, 11, 0x32, 0, 0, 5, 0xB3, 0, 0,
                    init[11], init[12], 0, 0, 0x72, 1, 0, 0 };
                Send(response, 0, response.Length);
                var incoming = new BlockingInputStream();
                var forwarding = Task.Run(async () =>
                {
                    try
                    {
                        while (true)
                        {
                            var packet = await Packet();
                            incoming.Add(packet, packet.Length);
                        }
                    }
                    catch (IOException) { }
                    finally { incoming.Complete(); }
                });
                var protocol = new TlsServerProtocol(incoming, new CallbackOutputStream(Send));
                protocol.Accept(server);
                try { applicationBytes = protocol.Stream.ReadByte() < 0 ? 0 : 1; }
                catch (IOException) { applicationBytes = 0; } // EOF/reset without close_notify.
                await forwarding;
            }, deadline.Token);
            byte[]? leaf = null;
            await S7CommPlusCertificateProbe.InspectAsync(new S7CommPlusClientOptions
            {
                Address = "127.0.0.1",
                Port = ((IPEndPoint)listener.LocalEndpoint).Port,
                Password = "must-not-be-sent",
                CertificateReceived = certificate => leaf = certificate
            }, deadline.Token);
            await serving.WaitAsync(deadline.Token);
            Assert.Equal(server.CertificateDer, leaf);
            Assert.Equal(32, server.OmsExporterSecret.Length); // Full handshake completed.
            Assert.Equal(0, applicationBytes);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(1)]
        [InlineData(2)]
        [InlineData(3)]
        public void CertificateTrustGatesHandshakeAndOmsExporter(int pinMode)
        {
            var serverInput = new BlockingInputStream();
            BouncyCastleTlsConnector? connector = null;
            var serverOutput = new CallbackOutputStream(
                (data, offset, count) => connector!.ReadCompleted(Copy(data, offset, count), count));
            var callback = new LoopbackConnectorCallback(serverInput);
            var server = new ExporterTlsServer();
            var pin = pinMode == 0 ? Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(server.CertificateDer))
                : pinMode == 1 ? null : new string('0', 64);
            byte[]? presented = null;
            connector = new BouncyCastleTlsConnector(callback, pin, leaf =>
            {
                presented = (byte[])leaf.Clone();
                leaf[0] ^= 1; // Observation must not mutate the certificate being validated.
            }, pinMode == 3);
            Exception? serverException = null;

            var serverThread = new Thread(() =>
            {
                try
                {
                    var protocol = new TlsServerProtocol(serverInput, serverOutput);
                    protocol.Accept(server);
                }
                catch (Exception ex)
                {
                    serverException = ex;
                }
            })
            {
                IsBackground = true,
                Name = "S7CommPlus test TLS server"
            };

            try
            {
                serverThread.Start();
                if (pinMode == 1 || pinMode == 2)
                {
                    Assert.ThrowsAny<Exception>(() => connector.StartHandshake());
                    Assert.Equal(server.CertificateDer, presented);
                    Assert.Throws<InvalidOperationException>(() => connector.GetOmsExporterSecret());
                    Assert.Empty(server.OmsExporterSecret);
                    return;
                }
                connector.StartHandshake();
                Assert.Equal(server.CertificateDer, presented);

                Assert.True(serverThread.Join(TimeSpan.FromSeconds(10)), "TLS server handshake did not complete.");
                Assert.Null(serverException);

                var firstExport = connector.GetOmsExporterSecret();
                var secondExport = connector.GetOmsExporterSecret();

                Assert.Equal(OmsExporterSecretLength, firstExport.Length);
                Assert.Equal(server.OmsExporterSecret, firstExport);
                Assert.Equal(firstExport, secondExport);
                Assert.NotSame(firstExport, secondExport);
            }
            finally
            {
                connector.Dispose();
                serverInput.Complete();
                Assert.True(serverThread.Join(TimeSpan.FromSeconds(10)), "TLS test server did not exit.");
            }
        }

        private static byte[] Copy(byte[] data, int offset, int count)
        {
            var copy = new byte[count];
            Buffer.BlockCopy(data, offset, copy, 0, count);
            return copy;
        }

        private sealed class ExporterTlsServer : DefaultTlsServer
        {
            private readonly AsymmetricKeyParameter _privateKey;
            private readonly byte[] _certificate;
            public byte[] CertificateDer => _certificate;

            public ExporterTlsServer()
                : base(new BcTlsCrypto(new SecureRandom()))
            {
                var keyPairGenerator = new RsaKeyPairGenerator();
                keyPairGenerator.Init(new KeyGenerationParameters(Crypto.SecureRandom, 2048));
                var keyPair = keyPairGenerator.GenerateKeyPair();

                _privateKey = keyPair.Private;
                _certificate = CreateCertificate(keyPair);
            }

            public byte[] OmsExporterSecret { get; private set; } = Array.Empty<byte>();

            public override int[] GetCipherSuites()
            {
                return new[]
                {
                    CipherSuite.TLS_AES_256_GCM_SHA384,
                    CipherSuite.TLS_AES_128_GCM_SHA256
                };
            }

            public override TlsCredentials GetCredentials()
            {
                var tlsCertificate = m_context.Crypto.CreateCertificate(_certificate);
                var certificate = new TlsCertificate(
                    TlsUtilities.EmptyBytes,
                    new[] { new CertificateEntry(tlsCertificate, null) });
                var signatureAlgorithm = TlsUtilities.ChooseSignatureAndHashAlgorithm(
                    m_context,
                    m_context.SecurityParameters.ClientSigAlgs,
                    SignatureAlgorithm.rsa);

                return new BcDefaultTlsCredentialedSigner(
                    new TlsCryptoParameters(m_context),
                    (BcTlsCrypto)m_context.Crypto,
                    _privateKey,
                    certificate,
                    signatureAlgorithm);
            }

            public override void NotifyHandshakeComplete()
            {
                base.NotifyHandshakeComplete();
                OmsExporterSecret = m_context.ExportKeyingMaterial(
                    OmsExporterLabel,
                    null,
                    OmsExporterSecretLength);
            }

            protected override TlsProtocolVersion[] GetSupportedVersions()
            {
                return TlsProtocolVersion.TLSv13.Only();
            }

            private static byte[] CreateCertificate(AsymmetricCipherKeyPair keyPair)
            {
                var certificateGenerator = new X509V3CertificateGenerator();
                var name = new X509Name("CN=S7CommPlusDriver Test");
                certificateGenerator.SetSerialNumber(BigInteger.One);
                certificateGenerator.SetIssuerDN(name);
                certificateGenerator.SetSubjectDN(name);
                certificateGenerator.SetNotBefore(DateTime.UtcNow.AddMinutes(-1));
                certificateGenerator.SetNotAfter(DateTime.UtcNow.AddMinutes(5));
                certificateGenerator.SetPublicKey(keyPair.Public);

                return certificateGenerator
                    .Generate(new Asn1SignatureFactory("SHA256WITHRSA", keyPair.Private))
                    .GetEncoded();
            }
        }

        private sealed class LoopbackConnectorCallback : IS7TlsConnectorCallback
        {
            private readonly BlockingInputStream _serverInput;

            public LoopbackConnectorCallback(BlockingInputStream serverInput)
            {
                _serverInput = serverInput;
            }

            public void WriteData(byte[] data, int dataLength)
            {
                _serverInput.Add(data, dataLength);
            }

            public void OnDataAvailable()
            {
            }

            public void OnSslError(int sslError, string sslState)
            {
            }
        }

        private sealed class BlockingInputStream : Stream
        {
            private readonly BlockingCollection<byte[]> _incoming = new BlockingCollection<byte[]>();
            private byte[] _current = Array.Empty<byte>();
            private int _offset;

            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public void Add(byte[] data, int count)
            {
                _incoming.Add(Copy(data, 0, count));
            }

            public void Complete()
            {
                _incoming.CompleteAdding();
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                while (_current == null || _offset >= _current.Length)
                {
                    try
                    {
                        _current = _incoming.Take();
                        _offset = 0;
                    }
                    catch (InvalidOperationException)
                    {
                        return 0;
                    }
                }

                var bytesToCopy = Math.Min(count, _current.Length - _offset);
                Buffer.BlockCopy(_current, _offset, buffer, offset, bytesToCopy);
                _offset += bytesToCopy;
                return bytesToCopy;
            }

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }

        private sealed class CallbackOutputStream : Stream
        {
            private readonly Action<byte[], int, int> _write;

            public CallbackOutputStream(Action<byte[], int, int> write)
            {
                _write = write;
            }

            public override bool CanRead => false;
            public override bool CanSeek => false;
            public override bool CanWrite => true;
            public override long Length => throw new NotSupportedException();
            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count)
            {
                _write(buffer, offset, count);
            }
        }
    }
}
