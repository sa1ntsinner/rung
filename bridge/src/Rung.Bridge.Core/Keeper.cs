// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Collections.Generic;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// What a keeper writes about itself: %LOCALAPPDATA%\rung\keepers\&lt;project hash&gt;.json. A keeper is a bridge
    /// process (--keep) that holds the project open in a TIA Portal without window for every other bridge.
    /// </summary>
    public sealed class KeeperRecord
    {
        public const string Starting = "starting", Ready = "ready", Failed = "failed";
        public int KeeperPid { get; set; }
        /// <summary>UTC start time of the keeper process: a pid Windows gave to another process later is not the keeper.</summary>
        public long KeeperStartTicks { get; set; }
        public int TiaPid { get; set; }
        /// <summary>UTC start time of the TIA Portal process, so a reused pid is never taken for it.</summary>
        public long TiaStartTicks { get; set; }
        public string Project { get; set; }
        public string State { get; set; }
        public string Error { get; set; }

        public void Fail(string error) { State = Failed; Error = error; }
    }

    public static class KeeperFile
    {
        public static string Dir =>
            Environment.GetEnvironmentVariable("RUNG_KEEPER_DIR") is string d && d.Length > 0 ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rung", "keepers");

        /// <summary>Same file for every spelling of the project path (case, slashes).</summary>
        public static string PathFor(string project) => Path.Combine(Dir, Key(project) + ".json");

        /// <summary>Short stable name for the project, also used for its mutexes.</summary>
        public static string Key(string project) =>
            Bundle.Sha256(Encoding.UTF8.GetBytes(project.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant())).Substring(0, 16);

        public static string MutexName(string purpose, string userSid, string project, bool global = true) =>
            (global ? @"Global\" : @"Local\") + "rung-" + purpose + "-" + userSid + "-" + Key(project);

        /// <summary>Shares delete: a reader polling while the keeper replaces its record never makes that replace fail.</summary>
        public static Stream OpenRead(string file) => new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

        public static KeeperRecord Read(string file)
        {
            try
            {
                using (var s = OpenRead(file))
                using (var r = new StreamReader(s, Encoding.UTF8))
                    return JsonSerializer.Deserialize<KeeperRecord>(r.ReadToEnd());
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException) { return null; }
        }

        /// <summary>Wait for the keeper to retire its own record; never remove another process's record.</summary>
        public static bool WaitForRelease(string file, int tiaPid, TimeSpan budget)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (File.Exists(file))
            {
                var record = Read(file);
                if (record != null && record.TiaPid != tiaPid) return true;
                if (clock.Elapsed >= budget) return false;
                System.Threading.Thread.Sleep(25);
            }
            return true;
        }

        /// <summary>Written whole or not at all: readers poll the file while the keeper starts.</summary>
        public static void Write(string file, KeeperRecord r)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            var tmp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(r));
            if (File.Exists(file)) File.Replace(tmp, file, null); else File.Move(tmp, file);
        }
    }

    public enum KeeperVerdict { Stay, Exit }

    public enum WindowStep { Show, Move, SaveAndMove, Unsaved, Busy, InUse }

    public static class PortalStartup
    {
        public static T Open<T>(Func<IDisposable> startLock, Func<T> attach, Func<T> create) where T : class
        {
            using (startLock()) return attach() ?? create();
        }
    }

    public sealed class SessionState
    {
        public bool Open { get; set; } = true;
        public string ProjectPath { get; set; }
        public int TiaPid { get; set; }
        public string Mode { get; set; }
        public string HeldBy { get; set; }
        public int? KeeperPid { get; set; }
        public int AttachedSessions { get; set; }
    }

    public static class SessionRelease
    {
        public static WindowStep Decide(bool hasWindow, bool keeperHolds, bool modified, bool saveAllowed, int attachedSessions = 2, bool discard = false) =>
            hasWindow || !keeperHolds ? WindowStep.Busy : attachedSessions > 2 ? WindowStep.InUse : discard ? WindowStep.Move : WindowHandoff.Decide(false, keeperHolds, modified, saveAllowed);
    }

    /// <summary>
    /// "Open in TIA Portal" while the project is open in a TIA Portal without window: a project opens in one TIA Portal
    /// at a time, so it moves into a TIA Portal with window. Only rung's own keeper is ever closed for it.
    /// </summary>
    public static class WindowHandoff
    {
        public static void Close(bool hasWindow, bool rungHolds, bool saveAllowed, Func<IDisposable> exclusive,
            Func<bool> modified, Action save, Action close)
        {
            if (hasWindow) return;
            if (!rungHolds) throw new RpcException(ErrorCodes.ProjectBusy, "Another program holds the project in a TIA Portal without window; close it there to open the project in TIA Portal.");
            using (exclusive())
            {
                var step = Decide(false, true, modified(), saveAllowed);
                if (step == WindowStep.Unsaved) throw new RpcException(ErrorCodes.ProjectUnsaved, "The project has changes that are not saved; opening it in a TIA Portal window closes it here first. Save them to go on (rung open --save).");
                if (step == WindowStep.SaveAndMove) save();
                close();
            }
        }

        public static WindowStep Decide(bool hasWindow, bool rungHolds, bool modified, bool saveAllowed)
        {
            if (hasWindow) return WindowStep.Show;
            if (!rungHolds) return WindowStep.Busy;
            if (!modified) return WindowStep.Move;
            return saveAllowed ? WindowStep.SaveAndMove : WindowStep.Unsaved;
        }
    }

    public static class KeeperPolicy
    {
        /// <summary>Closing needs verified identities: stale records and recycled PIDs grant no ownership.</summary>
        public static bool Holds(KeeperRecord r, int tiaPid, long? keeperStartTicks, long? tiaStartTicks) =>
            r != null && r.State == KeeperRecord.Ready && r.TiaPid == tiaPid && tiaPid > 0 && r.KeeperPid > 0
            && r.KeeperStartTicks > 0 && r.TiaStartTicks > 0
            && keeperStartTicks == r.KeeperStartTicks && tiaStartTicks == r.TiaStartTicks;

        public static TimeSpan IdleLimit =>
            int.TryParse(Environment.GetEnvironmentVariable("RUNG_KEEPER_IDLE_S"), out var s) && s > 0 ? TimeSpan.FromSeconds(s) : TimeSpan.FromMinutes(10);

        /// <param name="otherSessions">Openness clients attached besides the keeper.</param>
        /// <param name="lastBusy">Last time a client was attached (or the keeper started).</param>
        /// <summary>
        /// Saving is a write each bridge is allowed or not (sync.save of its workspace, which can change while the keeper
        /// runs): the keeper never saves, and with changes in the project it stays rather than discard them.
        /// </summary>
        public static KeeperVerdict Decide(bool projectOpen, int otherSessions, bool modified, DateTime lastBusy, DateTime now, TimeSpan idle)
        {
            if (!projectOpen) return KeeperVerdict.Exit; // closed by a bridge handing it to a TIA Portal window, or by hand
            if (otherSessions > 0 || now - lastBusy < idle) return KeeperVerdict.Stay;
            return modified ? KeeperVerdict.Stay : KeeperVerdict.Exit;
        }

        static readonly HashSet<string> KeeperEnvironment = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN",
            "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles", "CommonProgramFiles(x86)",
            "SystemDrive", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "COMPUTERNAME", "RUNG_OPENNESS_DIR"
        };

        /// <summary>Only Windows/runtime variables and keeper settings outlive the requesting command.</summary>
        public static bool KeeperGets(string name) => name != null && (KeeperEnvironment.Contains(name) || name.StartsWith("RUNG_KEEPER_", StringComparison.OrdinalIgnoreCase));

        public static void ForgetFailed(bool keeperAlive, Action sweep, Action forget)
        {
            if (keeperAlive) throw new RpcException(ErrorCodes.Busy, "The failed background keeper is still closing TIA Portal; try again once it ends.");
            sweep();
            forget();
        }

        /// <summary>
        /// A TIA Portal without window whose keeper is gone stays alive, invisible to Openness and holding the project
        /// lock. It is rung's own only when the record's pid still is the same process (start time) and Openness does
        /// not list it.
        /// </summary>
        public static bool IsOrphan(KeeperRecord r, bool keeperAlive, long? tiaStartTicks, bool listedByOpenness) =>
            r != null && r.TiaPid > 0 && !keeperAlive && tiaStartTicks == r.TiaStartTicks && !listedByOpenness;
    }
}
