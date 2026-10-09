#if NET6_0_OR_GREATER
using System;
using System.Runtime.InteropServices;

namespace S7CommPlusDriver
{
    internal sealed unsafe class BsdSocketS7Transport : IS7Transport
    {
        private const int AF_INET = 2;
        private const int SOCK_STREAM = 1;
        private const int IPPROTO_TCP = 6;
        private const int SOL_SOCKET = 0xffff;
        private const int SO_ERROR = 0x1007;
        private const int SO_NOSIGPIPE = 0x1022;
        private const int SO_RCVTIMEO = 0x1006;
        private const int SO_SNDTIMEO = 0x1005;
        private const int TCP_NODELAY = 0x01;
        private const int F_GETFL = 3;
        private const int F_SETFL = 4;
        private const int O_NONBLOCK = 0x0004;
        private const int EINPROGRESS = 36;
        private const ulong FIONBIO = 0x8004667e;

        private int _fd = -1;
        private int _receiveTimeoutMilliseconds;
        private int _sendTimeoutMilliseconds;

        public bool Connected => _fd >= 0;

        public int Connect(string address, int port, int connectTimeoutMilliseconds, int receiveTimeoutMilliseconds, int sendTimeoutMilliseconds)
        {
            Close();

            if (!TryParseIPv4(address, out var ipv4))
            {
                return S7Consts.errTCPConnectionFailed;
            }

            _fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
            if (_fd < 0 || _fd >= 1024)
            {
                Close();
                return S7Consts.errTCPConnectionFailed;
            }

            SetIntOption(IPPROTO_TCP, TCP_NODELAY, 1);
            SetIntOption(SOL_SOCKET, SO_NOSIGPIPE, 1);
            SetTimeouts(receiveTimeoutMilliseconds, sendTimeoutMilliseconds);

            if (!SetNonBlocking())
            {
                Close();
                return S7Consts.errTCPConnectionFailed;
            }

            byte* sockaddr = stackalloc byte[16];
            sockaddr[0] = 16;
            sockaddr[1] = AF_INET;
            sockaddr[2] = (byte)(port >> 8);
            sockaddr[3] = (byte)port;
            sockaddr[4] = ipv4[0];
            sockaddr[5] = ipv4[1];
            sockaddr[6] = ipv4[2];
            sockaddr[7] = ipv4[3];
            for (var index = 8; index < 16; index++)
            {
                sockaddr[index] = 0;
            }

            var result = connect(_fd, sockaddr, 16);
            if (result != 0)
            {
                var errno = Marshal.GetLastPInvokeError();
                if (errno != EINPROGRESS || !WaitForWritable(connectTimeoutMilliseconds))
                {
                    Close();
                    return S7Consts.errTCPConnectionFailed;
                }

                var socketError = 0;
                var socketErrorSize = sizeof(int);
                if (getsockopt(_fd, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorSize) != 0 || socketError != 0)
                {
                    Close();
                    return S7Consts.errTCPConnectionFailed;
                }
            }

            return 0;
        }

        public void SetTimeouts(int receiveTimeoutMilliseconds, int sendTimeoutMilliseconds)
        {
            _receiveTimeoutMilliseconds = receiveTimeoutMilliseconds;
            _sendTimeoutMilliseconds = sendTimeoutMilliseconds;
            if (_fd >= 0)
            {
                SetTimeoutOption(SO_RCVTIMEO, receiveTimeoutMilliseconds);
                SetTimeoutOption(SO_SNDTIMEO, sendTimeoutMilliseconds);
            }
        }

        public int Send(byte[] buffer)
        {
            return Send(buffer, buffer.Length);
        }

        public int Send(byte[] buffer, int size)
        {
            if (_fd < 0)
            {
                return S7Consts.errTCPNotConnected;
            }

            var sentTotal = 0;
            fixed (byte* bytes = buffer)
            {
                while (sentTotal < size)
                {
                    if (!WaitForWritable(_sendTimeoutMilliseconds))
                    {
                        return S7Consts.errTCPSendTimeout;
                    }

                    var sent = send(_fd, bytes + sentTotal, size - sentTotal, 0);
                    if (sent <= 0)
                    {
                        Close();
                        return S7Consts.errTCPDataSend;
                    }
                    sentTotal += sent;
                }
            }

            return 0;
        }

        public int Receive(byte[] buffer, int start, int size)
        {
            if (_fd < 0)
            {
                return S7Consts.errTCPNotConnected;
            }

            var receivedTotal = 0;
            fixed (byte* bytes = buffer)
            {
                while (receivedTotal < size)
                {
                    if (!WaitForReadable(_receiveTimeoutMilliseconds))
                    {
                        return S7Consts.errTCPReceiveTimeout;
                    }

                    var received = recv(_fd, bytes + start + receivedTotal, size - receivedTotal, 0);
                    if (received == 0)
                    {
                        Close();
                        return S7Consts.errTCPConnectionReset;
                    }
                    if (received < 0)
                    {
                        return S7Consts.errTCPDataReceive;
                    }
                    receivedTotal += received;
                }
            }

            return 0;
        }

        public int Close()
        {
            if (_fd >= 0)
            {
                _ = close(_fd);
                _fd = -1;
            }
            return 0;
        }

        public void Dispose()
        {
            Close();
        }

        private bool WaitForWritable(int timeoutMilliseconds)
        {
            return WaitForSocket(write: true, timeoutMilliseconds);
        }

        private bool WaitForReadable(int timeoutMilliseconds)
        {
            return WaitForSocket(write: false, timeoutMilliseconds);
        }

        private bool WaitForSocket(bool write, int timeoutMilliseconds)
        {
            var bits = stackalloc int[32];
            for (var index = 0; index < 32; index++)
            {
                bits[index] = 0;
            }
            bits[_fd / 32] |= 1 << (_fd % 32);

            var timeout = new TimeVal
            {
                Seconds = Math.Max(0, timeoutMilliseconds / 1000),
                Microseconds = Math.Max(0, timeoutMilliseconds % 1000) * 1000
            };

            return write
                ? select(_fd + 1, null, bits, null, &timeout) > 0
                : select(_fd + 1, bits, null, null, &timeout) > 0;
        }

        private bool SetNonBlocking()
        {
            var enabled = 1;
            if (ioctl(_fd, FIONBIO, &enabled) == 0)
            {
                return true;
            }

            var flags = fcntl(_fd, F_GETFL, 0);
            return flags >= 0 && fcntl(_fd, F_SETFL, flags | O_NONBLOCK) == 0;
        }

        private void SetIntOption(int level, int option, int value)
        {
            _ = setsockopt(_fd, level, option, &value, sizeof(int));
        }

        private void SetTimeoutOption(int option, int milliseconds)
        {
            var timeout = new TimeVal
            {
                Seconds = Math.Max(0, milliseconds / 1000),
                Microseconds = Math.Max(0, milliseconds % 1000) * 1000
            };
            _ = setsockopt(_fd, SOL_SOCKET, option, &timeout, sizeof(TimeVal));
        }

        private static bool TryParseIPv4(string address, out byte[] bytes)
        {
            bytes = new byte[4];
            var part = 0;
            var value = 0;
            var hasDigit = false;
            for (var index = 0; index < address.Length; index++)
            {
                var ch = address[index];
                if (ch >= '0' && ch <= '9')
                {
                    hasDigit = true;
                    value = checked(value * 10 + ch - '0');
                    if (value > 255)
                    {
                        return false;
                    }
                }
                else if (ch == '.' && hasDigit && part < 3)
                {
                    bytes[part++] = (byte)value;
                    value = 0;
                    hasDigit = false;
                }
                else
                {
                    return false;
                }
            }

            if (!hasDigit || part != 3)
            {
                return false;
            }

            bytes[part] = (byte)value;
            return true;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TimeVal
        {
            public long Seconds;
            public int Microseconds;
            private int _padding;
        }

        [DllImport("__Internal", SetLastError = true)]
        private static extern int socket(int domain, int type, int protocol);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int connect(int socket, byte* address, uint addressLength);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int send(int socket, byte* buffer, int length, int flags);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int recv(int socket, byte* buffer, int length, int flags);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int close(int socket);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int fcntl(int socket, int command, int value);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int ioctl(int socket, ulong request, int* value);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int setsockopt(int socket, int level, int option, void* value, int valueLength);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int getsockopt(int socket, int level, int option, void* value, int* valueLength);

        [DllImport("__Internal", SetLastError = true)]
        private static extern int select(int nfds, int* readfds, int* writefds, int* errorfds, TimeVal* timeout);
    }
}
#endif
