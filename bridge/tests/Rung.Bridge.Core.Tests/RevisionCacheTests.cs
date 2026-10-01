// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

/// <summary>Fingerprints kept by modification dates, within a bridge run and across runs (known from the client).</summary>
public class RevisionCacheTests
{
    static readonly DateTime T0 = new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
    readonly List<string> _read = new List<string>();

    Func<(string, string)> Read(string address, string fp) => () =>
    {
        _read.Add(address);
        return (fp, null);
    };

    /// <summary>One listing of objects o0..o(n-1) at now; returns which were read from TIA Portal.</summary>
    List<string> List(RevisionCache c, int n, DateTime now, IReadOnlyDictionary<string, KnownRevision> known = null)
    {
        _read.Clear();
        c.BeginList(known, now);
        for (var i = 0; i < n; i++) c.Get("o" + i, "k", now, Read("o" + i, "fp"));
        return _read.ToList();
    }

    [Fact]
    public void KeepsAFingerprintWhileTheDatesHoldAndReadsAgainWhenTheyChange()
    {
        var c = new RevisionCache();
        c.BeginList(null, T0);
        Assert.Equal("fp:1", c.Get("a", "dt:1|True", T0, Read("a", "fp:1")).Fingerprint);
        Assert.Equal("fp:1", c.Get("a", "dt:1|True", T0.AddMinutes(4), Read("a", "fp:2")).Fingerprint);
        Assert.Equal("fp:3", c.Get("a", "dt:2|True", T0.AddMinutes(4), Read("a", "fp:3")).Fingerprint);
        Assert.Equal("fp:4", c.Get("a", "dt:2|False", T0.AddMinutes(4), Read("a", "fp:4")).Fingerprint);
        Assert.Equal(3, _read.Count);
        Assert.Equal(3, c.Computed);
    }

    [Fact]
    public void ReadsTheOldestAgainAFewPerListingUntilEveryOneWasRead()
    {
        var c = new RevisionCache();
        var p = RevisionCache.RefreshPerList;
        var n = p * 2 + 5;
        Assert.Equal(n, List(c, n, T0).Count);
        var names = (int from, int count) => Enumerable.Range(from, count).Select(i => "o" + i);
        // listings far apart (one rung sync now and then): each reads those read longest ago
        var later = RevisionCache.Refresh + TimeSpan.FromMinutes(1);
        Assert.Equal(names(0, p), List(c, n, T0 + later));
        Assert.Equal(names(p, p), List(c, n, T0 + later + later));
        Assert.Equal(names(0, p - 5).Concat(names(2 * p, 5)), List(c, n, T0 + later + later + later)); // in walk order
        // within Refresh of reading them: nothing
        var fresh = new RevisionCache();
        List(fresh, n, T0);
        Assert.Empty(List(fresh, n, T0.AddMinutes(4)));
    }

    [Fact]
    public void ObjectsThatAreGoneDoNotTakeTheRefreshBudgetForever()
    {
        var c = new RevisionCache();
        var p = RevisionCache.RefreshPerList;
        List(c, p + 10, T0);
        // TIA Portal deleted the oldest ones: a complete listing sees only the rest
        var survivors = Enumerable.Range(p, 10).Select(i => "o" + i).ToList();
        List<string> ListSurvivors(DateTime at, IReadOnlyDictionary<string, KnownRevision> known = null)
        {
            _read.Clear();
            c.BeginList(known, at);
            foreach (var a in survivors) c.Get(a, "k", at, Read(a, "fp"));
            c.EndList(a => a.StartsWith("o", StringComparison.Ordinal));
            return _read.ToList();
        }
        var later = T0 + RevisionCache.Refresh + TimeSpan.FromMinutes(1);
        Assert.Empty(ListSurvivors(later)); // the gone ones were due this time, and are forgotten
        Assert.Equal(survivors, ListSurvivors(later.AddMinutes(1)));
        // a client that still sends a gone one: forgotten again at the end of that listing
        var known = new Dictionary<string, KnownRevision> { ["o0"] = new KnownRevision { Key = "k", Fingerprint = "fp", At = T0.ToString("o") } };
        var again = later + RevisionCache.Refresh + TimeSpan.FromMinutes(2);
        Assert.Equal(survivors, ListSurvivors(again, known));
        Assert.Empty(ListSurvivors(again.AddMinutes(1)));
    }

    [Fact]
    public void ReadsOneOlderThanMaxAgeOrFromTheFutureWhateverTheBudget()
    {
        var c = new RevisionCache();
        var n = RevisionCache.RefreshPerList + 2;
        List(c, n, T0);
        Assert.Equal(n, List(c, n, T0 + RevisionCache.MaxAge).Count);
        // the clock went back: everything is of unknown age
        Assert.Equal(n, List(c, n, T0).Count);
    }

    [Fact]
    public void UsesWhatTheClientKnewFromAnEarlierRunWhenTheDatesMatch()
    {
        var c = new RevisionCache();
        c.BeginList(new Dictionary<string, KnownRevision>
        {
            ["a"] = new KnownRevision { Key = "dt:1|True", Fingerprint = "fp:old", At = T0.ToString("o"), LibraryType = "Lib 1.0" },
            ["b"] = new KnownRevision { Key = "dt:1|True", Fingerprint = "fp:old", At = T0.ToString("o") },
            ["bad"] = new KnownRevision { Key = "k", Fingerprint = "fp", At = "yesterday" },
        }, T0.AddMinutes(1));
        var a = c.Get("a", "dt:1|True", T0.AddMinutes(1), Read("a", "fp:new"));
        Assert.Equal(("fp:old", "Lib 1.0", T0), (a.Fingerprint, a.LibraryType, a.At));
        Assert.Equal("fp:new", c.Get("b", "dt:2|True", T0.AddMinutes(1), Read("b", "fp:new")).Fingerprint);
        Assert.Equal("fp:new", c.Get("bad", "k", T0.AddMinutes(1), Read("bad", "fp:new")).Fingerprint);
        // what the bridge read itself wins over what a client sends later
        c.BeginList(new Dictionary<string, KnownRevision> { ["b"] = new KnownRevision { Key = "dt:2|True", Fingerprint = "fp:stale", At = T0.ToString("o") } }, T0.AddMinutes(2));
        Assert.Equal("fp:new", c.Get("b", "dt:2|True", T0.AddMinutes(2), Read("b", "fp:x")).Fingerprint);
        Assert.Equal(T0.ToString("o"), a.AtText);
    }

    [Fact]
    public void AStartedBridgeReadsOnlyTheOldestOfWhatTheClientKnew()
    {
        var known = Enumerable.Range(0, 60).ToDictionary(i => "o" + i, i => new KnownRevision { Key = "k", Fingerprint = "fp", At = T0.AddSeconds(i).ToString("o") });
        var read = List(new RevisionCache(), 60, T0.AddHours(10), known);
        Assert.Equal(Enumerable.Range(0, RevisionCache.RefreshPerList).Select(i => "o" + i), read);
    }

    [Fact]
    public void TheDispatcherPassesKnownToTheSession()
    {
        var session = new FakeTiaSession();
        var d = new RpcDispatcher(() => session, new BridgeInfo("V20", "t"));
        d.Handle("{\"id\":1,\"method\":\"objects.list\",\"params\":{\"device\":\"PLC_1\",\"known\":{\"plc:PLC_1/blocks/A\":{\"key\":\"dt:1|True\",\"fingerprint\":\"fp:1\",\"at\":\"2026-10-01T12:00:00.0000000Z\"}}}}");
        var k = session.Known["plc:PLC_1/blocks/A"];
        Assert.Equal(("dt:1|True", "fp:1", "2026-10-01T12:00:00.0000000Z"), (k.Key, k.Fingerprint, k.At));
        d.Handle("{\"id\":2,\"method\":\"objects.list\",\"params\":{\"device\":\"PLC_1\"}}");
        Assert.Null(session.Known);
    }
}
