// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Security.Principal;
using System.Threading;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;

namespace Rung.Bridge.V20
{
    /// <summary>
    /// Holds a project open in a TIA Portal without window for every bridge of that project (rung-bridge --keep).
    /// Starting TIA Portal takes seconds to minutes; attaching to a running one takes ~70 ms (measured, V20). A TIA
    /// Portal without window lives only as long as the process that started it, and one left behind by a process that
    /// died keeps the project locked while Openness no longer lists it, so the keeper is a process of its own, outside
    /// the tree of the editor or terminal that asked first, and cleans up after a dead keeper.
    /// </summary>
    static class Keeper
    {
        const string PortalProcess = "Siemens.Automation.Portal";
        static readonly TimeSpan StartBudget = TimeSpan.FromMinutes(5);

        // ------------------------------------------------------------ the keeper process

        public static int Run(BridgeArgs args)
        {
            if (string.IsNullOrEmpty(args.ProjectPath)) { Console.Error.WriteLine("--keep needs --project"); return 64; }
            var project = Path.GetFullPath(args.ProjectPath);
            var file = KeeperFile.PathFor(project);
            using (var own = ProjectMutex("keeper", project))
            {
                // a keeper that just failed or ended may still be closing its TIA Portal: wait for it, then hold
                bool mine;
                try { mine = own.WaitOne(TimeSpan.FromSeconds(60)); } catch (AbandonedMutexException) { mine = true; }
                if (!mine) return 0; // another keeper holds this project
                try
                {
                    int code = 0;
                    var t = new Thread(() => code = Hold(args, project, file));
                    t.SetApartmentState(ApartmentState.STA);
                    t.Start();
                    t.Join();
                    own.ReleaseMutex(); // the next keeper may start now; this one only waits for its TIA Portal to end
                    Reap(_reap);
                    return code;
                }
                catch { own.ReleaseMutex(); throw; }
            }
        }

        static int Hold(BridgeArgs args, string project, string file)
        {
            var self = Process.GetCurrentProcess();
            var me = self.Id;
            var myTicks = self.StartTime.ToUniversalTime().Ticks;
            var record = new KeeperRecord { KeeperPid = me, KeeperStartTicks = myTicks, Project = project, State = KeeperRecord.Starting };
            KeeperFile.Write(file, record);
            TiaPortal portal = null;
            Project opened = null;
            int tiaPid = 0;
            try
            {
                portal = new TiaPortal(TiaPortalMode.WithoutUserInterface);
                tiaPid = portal.GetCurrentProcess().Id;
                record.TiaPid = tiaPid;
                record.TiaStartTicks = StartTicks(tiaPid) ?? 0;
                // known before opening: a keeper killed while TIA Portal opens still leaves a TIA Portal to clean up
                KeeperFile.Write(file, record);
                var fi = new FileInfo(project);
                opened = args.CreateProject ? portal.Projects.Create(new DirectoryInfo(fi.Directory.Parent.FullName), Path.GetFileNameWithoutExtension(fi.Name)) : OpenWhenFree(portal, fi);
                record.State = KeeperRecord.Ready;
                KeeperFile.Write(file, record);
            }
            catch (Exception e)
            {
                // the bridge that waits for this keeper reads why, waits for it to close its TIA Portal and removes the record
                record.Fail(e.Message);
                KeeperFile.Write(file, record);
                End(portal, null, tiaPid);
                return 1;
            }

            var lastBusy = DateTime.UtcNow;
            try
            {
                while (true)
                {
                    Thread.Sleep(2000);
                    bool open, modified;
                    int others;
                    try
                    {
                        open = portal.Projects.Count > 0;
                        modified = open && opened.IsModified;
                        // the keeper's own attachment counts too
                        others = open ? Math.Max(0, portal.GetCurrentProcess().AttachedSessions.Count() - 1) : 0;
                    }
                    catch (Exception) when (Alive(tiaPid, null))
                    {
                        continue; // TIA Portal is busy or answered oddly once; only its end ends the keeper
                    }
                    var now = DateTime.UtcNow;
                    if (others > 0) lastBusy = now;
                    if (KeeperPolicy.Decide(open, others, modified, lastBusy, now, KeeperPolicy.IdleLimit) == KeeperVerdict.Stay) continue;
                    End(portal, open ? opened : null, tiaPid);
                    return 0;
                }
            }
            catch (Exception)
            {
                // TIA Portal went away (crash, killed, closed by hand): nothing left to hold
                End(portal, null, tiaPid);
                return 0;
            }
            finally
            {
                if (KeeperFile.Read(file)?.KeeperPid == me) try { File.Delete(file); } catch (IOException) { }
            }
        }

        /// <summary>
        /// Right after the engineer closed the TIA Portal window, its processes still hold the project for some seconds:
        /// try again in this TIA Portal (already started) instead of failing and starting over. A project open
        /// elsewhere (another PC) still fails, with TIA Portal's own message, after the wait.
        /// </summary>
        static Project OpenWhenFree(TiaPortal portal, FileInfo file)
        {
            var until = DateTime.UtcNow + TimeSpan.FromSeconds(45);
            while (true)
            {
                try { return portal.Projects.Open(file); }
                catch (EngineeringException) when (DateTime.UtcNow < until && !Listed(file.FullName)) { Thread.Sleep(3000); }
            }
        }

        static int _reap;

        /// <summary>Closes the project and lets go of TIA Portal; Run then waits for it to end (Reap), outside the lock.</summary>
        static void End(TiaPortal portal, Project project, int tiaPid)
        {
            try { project?.Close(); } catch (Exception) { }
            try { portal?.Dispose(); } catch (Exception) { }
            _reap = tiaPid;
        }

        /// <summary>A process that exits right after Dispose leaves TIA Portal running, invisible (measured): wait, else stop it.</summary>
        static void Reap(int tiaPid)
        {
            if (tiaPid <= 0) return;
            try
            {
                var p = Process.GetProcessById(tiaPid);
                if (!p.WaitForExit(30000)) p.Kill();
            }
            catch (ArgumentException) { } // already gone
            catch (InvalidOperationException) { }
        }
        // ------------------------------------------------------------ a bridge asking for one

        /// <summary>
        /// Makes sure a keeper holds the project, starting one when needed, and returns once its TIA Portal lists the
        /// project (the caller then attaches as to any TIA Portal). Throws when the keeper could not open it.
        /// </summary>
        public static void Ensure(BridgeArgs args, Action<string, object> emit)
        {
            var project = Path.GetFullPath(args.ProjectPath);
            var file = KeeperFile.PathFor(project);
            using (StartLock(project))
            {
                // another bridge may have opened it meanwhile: a keeper, or a TIA Portal window "Open in TIA Portal" made
                if (Listed(project)) return;
                var r = KeeperFile.Read(file);
                if (r != null && r.State == KeeperRecord.Failed)
                {
                    // left by a keeper that failed for an earlier bridge: let it finish closing, then start afresh
                    Forget(file, r, emit);
                    r = null;
                }
                if (r != null && !Alive(r.KeeperPid, r.KeeperStartTicks))
                {
                    SweepOrphan(r, emit);
                    try { File.Delete(file); } catch (IOException) { }
                    r = null;
                }
                var started = DateTime.UtcNow;
                if (r == null)
                {
                    emit("tia-starting", new { project, headless = true });
                    Spawn(args, project);
                }
                while (DateTime.UtcNow - started < StartBudget)
                {
                    if (Listed(project)) { emit("tia-started", new { project, pid = KeeperFile.Read(file)?.TiaPid ?? 0 }); return; }
                    r = KeeperFile.Read(file);
                    if (r?.State == KeeperRecord.Failed)
                    {
                        Forget(file, r, emit);
                        // typical: the project is locked by a TIA Portal on another PC or was opened by a newer version
                        throw new RpcException(ErrorCodes.NoProject, "Could not open " + project + " in the background: " + r.Error
                            + " A project protected by user management asks for its user: open it in TIA Portal, rung then works with that TIA Portal.");
                    }
                    if (r != null && !Alive(r.KeeperPid, r.KeeperStartTicks)) throw new RpcException(ErrorCodes.NoProject, "The background TIA Portal for " + project + " ended while opening it.");
                    Thread.Sleep(250);
                }
                throw new RpcException(ErrorCodes.NoProject, "TIA Portal did not open " + project + " within " + StartBudget.TotalMinutes + " minutes.");
            }
        }

        /// <summary>
        /// One opener of the project at a time, on this PC: bridges starting a keeper, and "Open in TIA Portal" between
        /// closing the project in the keeper and opening it in a window (else another workspace's watch could reopen it
        /// in the background in between).
        /// </summary>
        public static IDisposable StartLock(string project)
        {
            var m = ProjectMutex("keeper-start", project);
            try
            {
                if (!m.WaitOne(StartBudget)) { m.Dispose(); throw new RpcException(ErrorCodes.Busy, "Another rung is still opening " + project); }
            }
            catch (AbandonedMutexException) { }
            return new Held(m);
        }

        static Mutex ProjectMutex(string purpose, string project)
        {
            var sid = WindowsIdentity.GetCurrent().User.Value;
            project = Path.GetFullPath(project);
            try { return new Mutex(false, KeeperFile.MutexName(purpose, sid, project)); }
            catch (UnauthorizedAccessException)
            {
                // Global objects may be denied by host policy; Local still arbitrates bridges in this Windows session.
                return new Mutex(false, KeeperFile.MutexName(purpose, sid, project, false));
            }
        }

        sealed class Held : IDisposable
        {
            Mutex _m;
            public Held(Mutex m) { _m = m; }
            public void Dispose()
            {
                if (_m == null) return;
                try { _m.ReleaseMutex(); } finally { _m.Dispose(); _m = null; }
            }
        }

        /// <summary>Whether a TIA Portal that rung's keeper holds has this process id (the keeper's record says so).</summary>
        public static bool Holds(string project, int tiaPid)
        {
            var r = KeeperFile.Read(KeeperFile.PathFor(Path.GetFullPath(project)));
            return !string.IsNullOrEmpty(r?.Project) && SamePath(r.Project, Path.GetFullPath(project))
                && KeeperPolicy.Holds(r, tiaPid, ProcessTicks(r.KeeperPid), StartTicks(tiaPid));
        }

        static long? ProcessTicks(int pid)
        {
            if (pid <= 0) return null;
            try
            {
                using (var p = Process.GetProcessById(pid)) return !p.HasExited ? p.StartTime.ToUniversalTime().Ticks : (long?)null;
            }
            catch (Exception) { return null; } // ownership cannot be granted when identity is unknown
        }
        /// <summary>
        /// Started through WMI so it belongs to no process tree and no job: an editor or terminal stopping rung (process
        /// tree kill, Node's job object) must not take the TIA Portal every other bridge uses with it.
        /// </summary>
        static void Spawn(BridgeArgs args, string project)
        {
            var exe = Process.GetCurrentProcess().MainModule.FileName;
            var cmd = Quote(exe) + " --keep --project " + Quote(project) + (args.CreateProject ? " --create-project" : "");
            using (var cls = new ManagementClass("Win32_Process"))
            using (var startup = new ManagementClass("Win32_ProcessStartup"))
            {
                startup["ShowWindow"] = 0; // SW_HIDE
                // WMI starts it with the user's default environment; it needs this bridge's (RUNG_OPENNESS_DIR, RUNG_KEEPER_*),
                // never a password a command was given for one request: the keeper and its TIA Portal live on
                startup["EnvironmentVariables"] = Environment.GetEnvironmentVariables().Cast<System.Collections.DictionaryEntry>()
                    .Where(e => KeeperPolicy.KeeperGets((string)e.Key)).Select(e => e.Key + "=" + e.Value).ToArray();
                var inParams = cls.GetMethodParameters("Create");
                inParams["CommandLine"] = cmd;
                inParams["CurrentDirectory"] = Path.GetDirectoryName(exe);
                inParams["ProcessStartupInformation"] = startup;
                var result = cls.InvokeMethod("Create", inParams, null);
                var rc = Convert.ToInt32(result["ReturnValue"]);
                if (rc != 0) throw new InvalidOperationException("Win32_Process.Create returned " + rc);
            }
        }

        /// <summary>Stops the TIA Portal a dead keeper left behind, and only that one.</summary>
        static void SweepOrphan(KeeperRecord r, Action<string, object> emit)
        {
            if (!KeeperPolicy.IsOrphan(r, false, StartTicks(r.TiaPid), TiaPortal.GetProcesses().Any(p => p.Id == r.TiaPid))) return;
            try
            {
                Process.GetProcessById(r.TiaPid).Kill();
                emit("tia-orphan-stopped", new { project = r.Project, pid = r.TiaPid });
            }
            catch (Exception) { }
        }

        static bool Listed(string project) => TiaPortal.GetProcesses().Any(p => SamePath(p.ProjectPath?.FullName, project));

        /// <summary>startTicks: the process must be the one that started then (Windows reuses pids); null: any.</summary>
        static bool Alive(int pid, long? startTicks)
        {
            if (pid <= 0) return false;
            try
            {
                var p = Process.GetProcessById(pid);
                return !p.HasExited && (!startTicks.HasValue || startTicks.Value == 0 || p.StartTime.ToUniversalTime().Ticks == startTicks.Value);
            }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch (System.ComponentModel.Win32Exception) { return true; } // cannot look closer: count it as alive, never kill on a guess
        }

        /// <summary>A failed keeper's record: removed once that keeper has closed its TIA Portal (a new keeper waits for it too).</summary>
        static void Forget(string file, KeeperRecord r, Action<string, object> emit)
        {
            var until = DateTime.UtcNow + TimeSpan.FromSeconds(60);
            while (Alive(r.KeeperPid, r.KeeperStartTicks) && DateTime.UtcNow < until) Thread.Sleep(250);
            KeeperPolicy.ForgetFailed(Alive(r.KeeperPid, r.KeeperStartTicks), () => SweepOrphan(r, emit), () =>
            {
                var current = KeeperFile.Read(file);
                if (current?.KeeperPid == r.KeeperPid && current.KeeperStartTicks == r.KeeperStartTicks)
                    try { File.Delete(file); } catch (IOException) { }
            });
        }

        static long? StartTicks(int pid)
        {
            if (pid <= 0) return null;
            try
            {
                var p = Process.GetProcessById(pid);
                return p.ProcessName == PortalProcess && !p.HasExited ? p.StartTime.ToUniversalTime().Ticks : (long?)null;
            }
            catch (Exception) { return null; }
        }

        static bool SamePath(string a, string b) => a != null && string.Equals(Path.GetFullPath(a), b, StringComparison.OrdinalIgnoreCase);

        static string Quote(string s) => "\"" + s + "\"";
    }
}
