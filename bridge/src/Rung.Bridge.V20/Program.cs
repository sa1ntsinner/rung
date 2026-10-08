// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;

namespace Rung.Bridge.V20
{
    public sealed class BridgeArgs
    {
        public string ProjectPath;
        public bool AllowFixtureImport;
        public bool AllowImport;
        /// <summary>Save the project after every successful import, so a TIA crash cannot silently undo what rung wrote.</summary>
        public bool SaveAfterImport;
        /// <summary>When no TIA Portal has the project open, open it in a TIA Portal without window, owned by this bridge.</summary>
        public bool OpenHeadless;
        /// <summary>With OpenHeadless: create the project when its file does not exist yet (rung init --from-plc).</summary>
        public bool CreateProject;
        /// <summary>
        /// plc.download is refused without it: only `rung download` (and `rung watch` when downloads are on for the
        /// workspace) start a bridge that may download. Sync, pull, the MCP server and tools never ask for it.
        /// </summary>
        public bool AllowDownload;

        public static BridgeArgs Parse(string[] args)
        {
            var a = new BridgeArgs();
            for (var i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--project":
                        if (i + 1 >= args.Length) throw new ArgumentException("--project needs a path");
                        a.ProjectPath = args[++i];
                        break;
                    case "--allow-fixture-import":
                        a.AllowFixtureImport = true;
                        break;
                    case "--allow-import":
                        a.AllowImport = true;
                        break;
                    case "--save-after-import":
                        a.SaveAfterImport = true;
                        break;
                    case "--open-headless":
                        a.OpenHeadless = true;
                        break;
                    case "--create-project":
                        a.CreateProject = true;
                        break;
                    case "--allow-download":
                        a.AllowDownload = true;
                        break;
                    default:
                        throw new ArgumentException("unknown argument: " + args[i]);
                }
            }
            return a;
        }
    }

    public static class Program
    {
        public static int Main(string[] args)
        {
            // Ctrl+C in the terminal reaches every process there. rung stops and closes the bridge's input; the bridge
            // then finishes the request TIA Portal is running, lets go of its events and ends. Stopped at once, it
            // would leave TIA Portal handlers into a dead process (see OpennessSession.BeginRequest).
            Console.CancelKeyPress += (s, e) => e.Cancel = true;
            BridgeArgs parsed;
            try { parsed = BridgeArgs.Parse(args); }
            catch (ArgumentException e) { Console.Error.WriteLine(e.Message); return 64; }

            // Must be registered before any Siemens type is touched (Siemens-recommended pattern).
            var dir = Environment.GetEnvironmentVariable("RUNG_OPENNESS_DIR");
#if TIA_V21
            if (string.IsNullOrEmpty(dir)) dir = @"C:\Program Files\Siemens\Automation\Portal V21\PublicAPI\V21\net48";
#else
            if (string.IsNullOrEmpty(dir)) dir = @"C:\Program Files\Siemens\Automation\Portal V20\PublicAPI\V20";
#endif
            AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
            {
                var name = new AssemblyName(e.Name).Name;
                if (!name.StartsWith("Siemens.Engineering", StringComparison.Ordinal)) return null;
                var path = Path.Combine(dir, name + ".dll");
                return File.Exists(path) ? Assembly.LoadFrom(path) : null;
            };
            return Run(parsed);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        static int Run(BridgeArgs args) => Host.Run(args);
    }
}
