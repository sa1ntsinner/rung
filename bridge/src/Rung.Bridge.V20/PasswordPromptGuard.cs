// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Rung.Bridge.V20
{
    /// <summary>
    /// Cancels TIA Portal's know-how password dialog while rung writes to the project.
    /// GenerateBlocksFromSource shows a modal "Access protection"
    /// prompt when the PLC contains a know-how protected block. Openness raises no Confirmation for it
    /// and the call blocks until someone answers. Cancelling lets the generation finish normally.
    /// </summary>
    sealed class PasswordPromptGuard : IDisposable
    {
        // Dialog captions per TIA UI language; RUNG_PASSWORD_DIALOG_TITLES (';'-separated) adds more.
        static readonly string[] Titles = new[] { "Access protection", "Zugriffsschutz" }
            .Concat((Environment.GetEnvironmentVariable("RUNG_PASSWORD_DIALOG_TITLES") ?? "").Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            .ToArray();

        readonly uint _pid;
        readonly Thread _thread;
        readonly HashSet<IntPtr> _seen = new HashSet<IntPtr>();
        // set by Dispose: the guard ends at once, not after the rest of its 200 ms (every import and compile waited for it)
        readonly ManualResetEventSlim _stop = new ManualResetEventSlim();

        public int Cancelled { get { lock (_seen) return _seen.Count; } }

        public PasswordPromptGuard(int tiaProcessId)
        {
            _pid = (uint)tiaProcessId;
            _thread = new Thread(Run) { IsBackground = true, Name = "rung-password-guard" };
            _thread.Start();
        }

        void Run()
        {
            do
            {
                try { EnumWindows(Visit, IntPtr.Zero); } catch (Exception) { }
            }
            while (!_stop.Wait(200));
        }

        bool Visit(IntPtr hwnd, IntPtr _)
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            if (pid != _pid || !IsWindowVisible(hwnd)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(hwnd, sb, sb.Capacity);
            if (Array.IndexOf(Titles, sb.ToString()) < 0) return true;
            PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); // same as the dialog's Cancel
            lock (_seen) _seen.Add(hwnd);
            return true;
        }

        public void Dispose()
        {
            _stop.Set();
            if (_thread.Join(1000)) _stop.Dispose();
        }

        const uint WM_CLOSE = 0x0010;
        delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    }
}
