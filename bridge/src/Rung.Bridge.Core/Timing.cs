// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// How long the phases of one operation took, one line per operation in the file RUNG_BRIDGE_TIMING names
    /// (nothing when it is unset). For measuring rung on large projects, not for normal use.
    /// </summary>
    public sealed class Timing
    {
        readonly string _file;
        readonly Stopwatch _watch = Stopwatch.StartNew();
        readonly List<string> _laps = new List<string>();

        public Timing() : this(Environment.GetEnvironmentVariable("RUNG_BRIDGE_TIMING")) { }

        public Timing(string file) => _file = string.IsNullOrEmpty(file) ? null : file;

        public void Lap(string phase)
        {
            if (_file == null) return;
            _laps.Add(phase + "=" + _watch.ElapsedMilliseconds + "ms");
            _watch.Restart();
        }

        public void Done(string what)
        {
            if (_file == null) return;
            try { File.AppendAllText(_file, DateTime.UtcNow.ToString("o") + " " + what + " " + string.Join(" ", _laps) + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
