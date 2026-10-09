// SPDX-License-Identifier: BUSL-1.1
// "Open in TIA Portal": a project opens in one TIA Portal at a time, so a project rung holds without window moves into a
// TIA Portal window (measured, V20: ~20 s). The window then belongs to the engineer; rung only attaches to it.
using System;
using System.IO;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        void MoveToWindow(bool save)
        {
            var path = _project.Path.FullName;
            var hasWindow = _portal.GetCurrentProcess().Mode == TiaPortalMode.WithUserInterface;
            var rungHolds = _ownsPortal || Keeper.Holds(path, _tiaPid);
            if (hasWindow) return;

            // no other bridge of this PC opens the project in between (another workspace's watch would reopen it in
            // the background and the window could not have it)
            using (Keeper.StartLock(path))
            {
                WindowHandoff.Close(false, rungHolds, save || _args.SaveAfterImport,
                    () => _portal.ExclusiveAccess("rung: open project in window"),
                    () => _project.IsModified, () => _project.Save(), () =>
                    {
                        var pid = _tiaPid;
                        _tiaPid = 0; // the keeper's TIA Portal ending now is expected (WatchTia)
                        try { _project.Close(); } // the keeper sees its project gone and ends
                        catch { _tiaPid = pid; throw; }
                    });
                if (_listening) { _portal.Notification -= OnNotification; _portal.Confirmation -= OnConfirmation; _listening = false; }
                try { _portal.Dispose(); } catch (Exception) { }
                _index.Clear();
                _ownsPortal = false; // the window is the engineer's: rung never closes it
                _emit("tia-starting", new { project = path, headless = false });
                var portal = new TiaPortal(TiaPortalMode.WithUserInterface);
                try
                {
                    _project = portal.Projects.Open(new FileInfo(path));
                }
                catch (Exception)
                {
                    try { portal.Dispose(); } catch (Exception) { }
                    _disposed = true; // nothing left attached: the next request says so and the client starts over
                    throw;
                }
                _portal = portal;
                _tiaPid = portal.GetCurrentProcess().Id;
                WatchTia();
                _emit("tia-started", new { project = path, pid = _tiaPid, window = true });
            }
        }

        /// <summary>No TIA Portal has the project open and the client wants a window (rung open): start one with window.</summary>
        static OpennessSession OpenWindow(BridgeArgs args, Action<string, object> emit)
        {
            var file = new FileInfo(Path.GetFullPath(args.ProjectPath));
            if (!file.Exists) throw new RpcException(ErrorCodes.NoProject, "Project file not found: " + file.FullName);
            return PortalStartup.Open(() => Keeper.StartLock(file.FullName),
                () => TiaPortal.GetProcesses().Any(p => string.Equals(p.ProjectPath?.FullName, file.FullName, StringComparison.OrdinalIgnoreCase)) ? Attach(args, emit) : null,
                () => CreateWindow(args, emit, file));
        }

        static OpennessSession CreateWindow(BridgeArgs args, Action<string, object> emit, FileInfo file)
        {
            emit("tia-starting", new { project = file.FullName, headless = false });
            var portal = new TiaPortal(TiaPortalMode.WithUserInterface);
            try
            {
                var project = portal.Projects.Open(file);
                var pid = portal.GetCurrentProcess().Id;
                emit("tia-started", new { project = file.FullName, pid, window = true });
                return new OpennessSession(portal, project, args, emit, pid);
            }
            catch (EngineeringException e)
            {
                try { portal.Dispose(); } catch (Exception) { }
                throw new RpcException(ErrorCodes.NoProject, "Could not open " + file.FullName + " in TIA Portal: " + e.Message);
            }
        }
    }
}
