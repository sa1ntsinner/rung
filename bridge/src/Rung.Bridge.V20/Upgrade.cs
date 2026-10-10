// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Siemens.Engineering;

namespace Rung.Bridge.V20
{
    /// <summary>
    /// rung-bridge --upgrade --project &lt;copy&gt;: opens a project of an older TIA Portal with upgrade, in a TIA Portal
    /// without window, saves it and prints where the upgraded project file is ({"path": …}). rung hands it a copy: the
    /// original stays as it was.
    /// </summary>
    static class Upgrade
    {
        public static int Run(BridgeArgs args)
        {
            if (string.IsNullOrEmpty(args.ProjectPath)) { Console.Error.WriteLine("--upgrade needs --project"); return 64; }
            var code = 1;
            var t = new Thread(() => code = Open(new FileInfo(Path.GetFullPath(args.ProjectPath))));
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return code;
        }

        static int Open(FileInfo file)
        {
            TiaPortal portal = null;
            Project project = null;
            var tiaPid = 0;
            try
            {
                portal = new TiaPortal(TiaPortalMode.WithoutUserInterface);
                tiaPid = portal.GetCurrentProcess().Id;
                // rung stops this TIA Portal itself when the upgrade waits too long (a dialog a TIA Portal without window cannot show)
                Console.Out.WriteLine("{\"tiaPid\":" + tiaPid + "}");
                Console.Out.Flush();
                project = portal.Projects.OpenWithUpgrade(file);
                project.Save();
                Console.Out.WriteLine("{\"path\":" + Json(project.Path.FullName) + "}");
                return 0;
            }
            catch (Exception e)
            {
                Console.Out.WriteLine("{\"error\":" + Json(e.Message) + "}");
                return 1;
            }
            finally
            {
                try { project?.Close(); } catch (Exception) { }
                try { portal?.Dispose(); } catch (Exception) { }
                // a TIA Portal without window outlives a process that ends right after Dispose (Keeper.Reap)
                if (tiaPid > 0) try { var p = Process.GetProcessById(tiaPid); if (!p.WaitForExit(30000)) p.Kill(); } catch (ArgumentException) { } catch (InvalidOperationException) { }
            }
        }

        static string Json(string s)
        {
            var b = new System.Text.StringBuilder("\"");
            foreach (var c in s)
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
    }
}
