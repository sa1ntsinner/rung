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
        /// <summary>Save the project after every successful import, so a TIA crash cannot silently undo what rung wrote (QA-2).</summary>
        public bool SaveAfterImport;
        /// <summary>When no TIA Portal has the project open, open it in a TIA Portal without window, owned by this bridge.</summary>
        public bool OpenHeadless;

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
