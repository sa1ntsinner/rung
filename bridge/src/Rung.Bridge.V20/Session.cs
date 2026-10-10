// SPDX-License-Identifier: BUSL-1.1
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        public static SessionState ProbeSession(BridgeArgs args)
        {
            var processes = TiaPortal.GetProcesses();
            PortalCandidate chosen;
            try { chosen = PortalSelector.Choose(processes.Select(p => new PortalCandidate(p.Id, p.ProjectPath?.FullName)).ToList(), args.ProjectPath); }
            catch (RpcException e) when (e.Code == ErrorCodes.TiaNotRunning || e.Code == ErrorCodes.NoProject)
            {
                var keeper = string.IsNullOrEmpty(args.ProjectPath) ? null : KeeperFile.Read(KeeperFile.PathFor(args.ProjectPath));
                return new SessionState { ProjectPath = args.ProjectPath, Open = false, KeeperPid = keeper?.KeeperPid };
            }
            return StateOf(processes.First(p => p.Id == chosen.Pid), false);
        }

        static SessionState StateOf(TiaPortalProcess process, bool self)
        {
            var path = process.ProjectPath?.FullName;
            var keeper = path != null && Keeper.Holds(path, process.Id) ? KeeperFile.Read(KeeperFile.PathFor(path)) : null;
            return new SessionState {
                ProjectPath = path, TiaPid = process.Id,
                Mode = process.Mode == TiaPortalMode.WithUserInterface ? "ui" : "headless",
                HeldBy = keeper != null ? "keeper" : self ? "self" : "other",
                KeeperPid = keeper?.KeeperPid,
                AttachedSessions = process.AttachedSessions.Count(),
            };
        }

        public SessionState GetSessionState() => StateOf(_portal.GetCurrentProcess(), _ownsPortal);

        public void ReleaseSession(bool save, bool discard = false)
        {
            var path = _project.Path.FullName;
            using (Keeper.StartLock(path))
            {
                var window = _portal.GetCurrentProcess().Mode == TiaPortalMode.WithUserInterface;
                var holds = Keeper.Holds(path, _tiaPid);
                var pid = _tiaPid;
                if (window || !holds) throw new RpcException(ErrorCodes.ProjectBusy, "Only rung's background keeper can release the project; this TIA Portal belongs to a window or another program.");
                using (var access = _portal.ExclusiveAccess("rung: release project"))
                {
                    var step = SessionRelease.Decide(window, holds, _project.IsModified, save || _args.SaveAfterImport, _portal.GetCurrentProcess().AttachedSessions.Count(), discard);
                    if (step == WindowStep.InUse) throw new RpcException(ErrorCodes.ProjectInUse, "Cannot release the project: rung watch of another workspace uses it. Stop that Watch before releasing.");
                    if (step == WindowStep.Unsaved) throw new RpcException(ErrorCodes.ProjectUnsaved, "The project has unsaved changes. Use rung session --release --save to save them, or --release --discard to lose them and close without saving.");
                    if (step == WindowStep.SaveAndMove) _project.Save();
                    _tiaPid = 0; // the keeper ending is expected: do not exit before replying
                    try { _project.Close(); } // the keeper notices and ends itself
                    catch { _tiaPid = pid; throw; }
                }
                Dispose();
                // Ensure must not see a Ready record for a project the keeper is already closing.
                if (!KeeperFile.WaitForRelease(KeeperFile.PathFor(path), pid, System.TimeSpan.FromSeconds(60)))
                    System.Console.Error.WriteLine("rung bridge: project released; its background keeper is still ending");
            }
        }
    }
}
