// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    /// <summary>One dedicated thread that owns the TIA Portal connection; every Openness call is queued onto it.</summary>
    public sealed class OwnerThread : IDisposable
    {
        readonly BlockingCollection<Action> _queue = new BlockingCollection<Action>();
        readonly Thread _thread;
        volatile bool _disposed;

        public OwnerThread(ApartmentState apartment = ApartmentState.MTA)
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "rung-owner" };
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) _thread.SetApartmentState(apartment);
            _thread.Start();
        }

        public int ManagedThreadId => _thread.ManagedThreadId;

        void Loop()
        {
            foreach (var job in _queue.GetConsumingEnumerable()) job();
        }

        public Task<T> Run<T>(Func<T> work)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(OwnerThread));
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(() =>
            {
                try { tcs.SetResult(work()); }
                catch (Exception e) { tcs.SetException(e); }
            });
            return tcs.Task;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _queue.CompleteAdding();
            _thread.Join(TimeSpan.FromSeconds(10));
        }
    }

    /// <summary>Reads request lines from stdin and writes response/event lines to stdout (UTF-8, no BOM).</summary>
    public sealed class StdioHost
    {
        readonly object _writeLock = new object();
        readonly TextWriter _out;
        readonly TextReader _in;

        public StdioHost(TextReader input, TextWriter output) { _in = input; _out = output; }

        public static StdioHost FromConsole()
        {
            var utf8 = new UTF8Encoding(false);
            var input = new StreamReader(Console.OpenStandardInput(), utf8);
            var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
            return new StdioHost(input, output);
        }

        public void WriteLine(string line)
        {
            lock (_writeLock) { _out.WriteLine(line); _out.Flush(); }
        }

        public void Emit(string eventName, object parameters) => WriteLine(RpcDispatcher.Event(eventName, parameters));

        /// <summary>Processes requests in order until stdin closes.</summary>
        public void Run(RpcDispatcher dispatcher, OwnerThread owner)
        {
            string line;
            while ((line = _in.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                var request = line;
                WriteLine(owner.Run(() => dispatcher.Handle(request)).GetAwaiter().GetResult());
            }
        }
    }
}
