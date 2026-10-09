using System;
using System.Linq;
using System.IO;
using System.Security.Cryptography;
using Xunit;

namespace S7CommPlusDriver.Tests
{
    public sealed class S7CommPlusProtocolSessionReceiveTests
    {
        [Fact]
        public void IdleNotificationReaderYieldsTheReceiveLockToPendingRequests()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();
            var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            typeof(S7CommPlusProtocolSession).GetField("m_LastSentRequestForWait", flags)!.SetValue(connection,
                new GetVarSubstreamedRequest(ProtocolVersion.V1));
            connection.DebugOnDataReceivedForTests(new byte[] { 0x72, ProtocolVersion.V1, 0, 1, 0xAA, 0x72, ProtocolVersion.V1, 0, 0 });
            var dispatch = typeof(S7CommPlusProtocolSession).GetMethod("DispatchOneReceivedPdu", flags)!;
            Assert.Equal(S7Consts.errCliJobTimeout, dispatch.Invoke(connection, new object[] { 250, null!, 1u, null!, null! }));
            Assert.Equal(0, connection.DebugReceiveNextS7plusPduForTests(10, out var pdu));
            Assert.NotNull(pdu); // The foreground waiter still owns the queued PDU.
        }
        [Fact]
        public async System.Threading.Tasks.Task NotificationReaderRetainsThePendingRequestResponse()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();
            var request = new GetVarSubstreamedRequest(ProtocolVersion.V1) { SequenceNumber = 17 };
            var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
            var receiveLock = typeof(S7CommPlusProtocolSession).GetField("m_ReceiveDispatchLock", flags)!.GetValue(connection)!;
            var dispatch = typeof(S7CommPlusProtocolSession).GetMethod("DispatchOneReceivedPdu", flags)!;
            var activeReader = System.Threading.Tasks.Task.Run(() => dispatch.Invoke(connection, new object[] { 1000, null!, 1u, null!, null! }));
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (System.Threading.Monitor.TryEnter(receiveLock)) {
                System.Threading.Monitor.Exit(receiveLock);
                Assert.True(deadline.ElapsedMilliseconds < 500, "Notification reader did not start.");
                await System.Threading.Tasks.Task.Delay(1);
            }
            typeof(S7CommPlusProtocolSession).GetField("m_LastSentRequestForWait", flags)!.SetValue(connection, request);
            connection.DebugOnDataReceivedForTests(new byte[] { 0x72, ProtocolVersion.V1, 0, 9, Opcode.Response, 0, 0,
                (byte)(request.FunctionCode >> 8), (byte)request.FunctionCode, 0, 0, 0, 17, 0x72, ProtocolVersion.V1, 0, 0 });
            Assert.Equal(0, await activeReader);
            var waitResponse = typeof(S7CommPlusProtocolSession).GetMethod("WaitForExpectedResponse", flags)!;
            Assert.Equal(0, waitResponse.Invoke(connection, new object[] { request, 10 }));
        }
        [Fact]
        public void RequestTimeoutReplacesHandshakeTimeoutAfterConnection()
        {
            var connection = new S7CommPlusProtocolSession();

            var timeouts = connection.DebugApplyRequestTimeoutForTests(5000, 120000);

            Assert.Equal(120000, timeouts.ProtocolReadTimeout);
            Assert.Equal(120000, timeouts.TransportReceiveTimeout);
            Assert.Equal(120000, timeouts.TransportSendTimeout);
        }

        [Fact]
        public void MalformedPduPublishesReceiveError()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();

            connection.DebugOnDataReceivedForTests(new byte[] { 0x00, ProtocolVersion.V1, 0x00, 0x00 });
            var error = connection.DebugReceiveNextS7plusPduForTests(100, out var pdu);

            Assert.Equal(S7Consts.errIsoInvalidPDU1, error);
            Assert.Null(pdu);
        }

        [Fact]
        public void InvalidProtocolVersionPublishesReceiveError()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();

            connection.DebugOnDataReceivedForTests(new byte[] { 0x72, 0x42, 0x00, 0x00 });
            var error = connection.DebugReceiveNextS7plusPduForTests(100, out var pdu);

            Assert.Equal(S7Consts.errIsoInvalidPDU2, error);
            Assert.Null(pdu);
        }

        [Fact]
        public void CompletePduIsDispatchedWithoutPolling()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();

            connection.DebugOnDataReceivedForTests(new byte[] { 0x72, ProtocolVersion.V1, 0x00, 0x01, 0xAA, 0x72, ProtocolVersion.V1, 0x00, 0x00 });
            var error = connection.DebugReceiveNextS7plusPduForTests(100, out MemoryStream pdu);

            Assert.Equal(0, error);
            Assert.NotNull(pdu);
            Assert.Equal(new byte[] { ProtocolVersion.V1, 0xAA }, pdu.ToArray());
        }

        [Fact]
        public void ReceiveTimeoutReturnsJobTimeout()
        {
            var connection = new S7CommPlusProtocolSession();
            connection.DebugResetReceiveDispatcherForTests();

            var error = connection.DebugReceiveNextS7plusPduForTests(10, out var pdu);

            Assert.Equal(S7Consts.errCliJobTimeout, error);
            Assert.Null(pdu);
        }

        [Fact]
        public void WriteBatchStopsBeforeSerializedPayloadExceedsLimit()
        {
            var connection = new S7CommPlusProtocolSession();
            var addresses = Enumerable.Range(1, 3)
                .Select(i => new ItemAddress($"8A0E{i:X4}.1"))
                .ToArray();
            var values = Enumerable.Range(1, 3)
                .Select(_ => (PValue)new ValueBlob(0, new byte[600]))
                .ToArray();

            var batch = connection.DebugCreateWriteRequestBatchForTests(addresses, values, 3, 987);

            Assert.Equal(1, batch.ItemCount);
            Assert.InRange(batch.SerializedLength, 1, 987);
        }

        [Fact]
        public void WriteBatchStillAllowsOneIntrinsicallyOversizedItem()
        {
            var connection = new S7CommPlusProtocolSession();
            var addresses = new[] { new ItemAddress("8A0E0001.1") };
            var values = new PValue[] { new ValueBlob(0, new byte[600]) };

            var batch = connection.DebugCreateWriteRequestBatchForTests(addresses, values, 20, 128);

            Assert.Equal(1, batch.ItemCount);
            Assert.True(batch.SerializedLength > 128);
        }

        [Fact]
        public void WriteBatchAlsoHonorsPlcItemLimit()
        {
            var connection = new S7CommPlusProtocolSession();
            var addresses = Enumerable.Range(1, 5)
                .Select(i => new ItemAddress($"8A0E{i:X4}.1"))
                .ToArray();
            var values = Enumerable.Range(1, 5)
                .Select(i => (PValue)new ValueDInt(i))
                .ToArray();

            var batch = connection.DebugCreateWriteRequestBatchForTests(addresses, values, 3, 987);

            Assert.Equal(3, batch.ItemCount);
            Assert.InRange(batch.SerializedLength, 1, 987);
        }

    }
}
