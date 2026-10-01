// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Rung.Bridge.Core.Model;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// Fingerprints by modification dates. TIA Portal answers one call at a time and a fingerprint costs 25-60 ms, so
    /// listing 1200 blocks took 40 s: an object whose dates and consistency are unchanged keeps the fingerprint it had,
    /// also across bridge runs (the client keeps them and sends them as known). The oldest ones are read again a few at
    /// a time (RefreshPerList per listing, once older than Refresh), so every one is checked again before long without
    /// reading a large project in one go; one older than MaxAge is always read. A stale fingerprint only delays
    /// noticing an edit that left the dates alone: imports and deletes compare the real revision, never this cache.
    /// </summary>
    public sealed class RevisionCache
    {
        public static readonly TimeSpan Refresh = TimeSpan.FromMinutes(5);
        public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);
        public const int RefreshPerList = 25;

        public sealed class Revision
        {
            public string Key;
            public string Fingerprint;
            public string LibraryType;
            public DateTime At;
            public string AtText => At.ToString("o", CultureInfo.InvariantCulture);
        }

        readonly Dictionary<string, Revision> _byAddress = new Dictionary<string, Revision>(StringComparer.Ordinal);
        HashSet<string> _due = new HashSet<string>(StringComparer.Ordinal);

        /// <summary>How many revisions were read from TIA Portal so far (the rest came from the cache).</summary>
        public int Computed { get; private set; }

        /// <summary>
        /// A new listing at now, with what the client knows from earlier runs (for objects this bridge has not read
        /// itself); picks the oldest ones to read again.
        /// </summary>
        public void BeginList(IReadOnlyDictionary<string, KnownRevision> known, DateTime now)
        {
            if (known != null)
                foreach (var k in known)
                {
                    var v = k.Value;
                    if (v == null || v.Key == null || v.Fingerprint == null || _byAddress.ContainsKey(k.Key)) continue;
                    if (!DateTime.TryParse(v.At, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var at)) continue;
                    _byAddress[k.Key] = new Revision { Key = v.Key, Fingerprint = v.Fingerprint, LibraryType = v.LibraryType, At = at };
                }
            _due = new HashSet<string>(
                _byAddress.Where(e => now - e.Value.At >= Refresh).OrderBy(e => e.Value.At).Take(RefreshPerList).Select(e => e.Key),
                StringComparer.Ordinal);
        }

        /// <summary>The revision of the object at address whose dates and consistency are key: kept, or read now.</summary>
        public Revision Get(string address, string key, DateTime now, Func<(string Fingerprint, string LibraryType)> read)
        {
            if (_byAddress.TryGetValue(address, out var r) && r.Key == key && !_due.Contains(address))
            {
                var age = now - r.At;
                // one from a clock that was ahead is of unknown age
                if (age >= TimeSpan.Zero && age < MaxAge) return r;
            }
            var (fingerprint, libraryType) = read();
            Computed++;
            return _byAddress[address] = new Revision { Key = key, Fingerprint = fingerprint, LibraryType = libraryType, At = now };
        }
    }
}
