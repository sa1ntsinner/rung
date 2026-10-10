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
    /// original stays as it was. rung-bridge --retrieve --project &lt;archive.zap20&gt; --target &lt;folder&gt;: the same for an archive.
    /// </summary>
    static class Upgrade
    {
        public static int Run(BridgeArgs args)
        {
            if (string.IsNullOrEmpty(args.ProjectPath)) { Console.Error.WriteLine("--upgrade and --retrieve need --project"); return 64; }
            if (args.Retrieve && string.IsNullOrEmpty(args.TargetPath)) { Console.Error.WriteLine("--retrieve needs --target"); return 64; }
            var file = new FileInfo(Path.GetFullPath(args.ProjectPath));
            Func<TiaPortal, Project> open = portal => portal.Projects.OpenWithUpgrade(file);
            if (args.Retrieve)
            {
                var target = new DirectoryInfo(Path.GetFullPath(args.TargetPath));
                // an archive of this TIA Portal version is retrieved as it is; an older one with upgrade
                open = portal => ArchiveVersion(file.Name) < OwnVersion ? portal.Projects.RetrieveWithUpgrade(file, target) : portal.Projects.Retrieve(file, target);
            }
            var code = 1;
            var t = new Thread(() => code = Open(open));
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return code;
        }

#if TIA_V21
        const int OwnVersion = 21;
#elif TIA_V19
        const int OwnVersion = 19;
#else
        const int OwnVersion = 20;
#endif
        /// <summary>Project.zap20 -> 20; 0 when the name says nothing.</summary>
        internal static int ArchiveVersion(string name)
        {
            var m = System.Text.RegularExpressions.Regex.Match(name, @"\.zap(\d+)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            return m.Success ? int.Parse(m.Groups[1].Value) : 0;
        }

        static int Open(Func<TiaPortal, Project> open)
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
                project = open(portal);
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
