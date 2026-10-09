// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Reflection;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.V20
{
    static class Host
    {
        public static int Run(BridgeArgs args)
        {
            var io = StdioHost.FromConsole();
            var version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            var caps = args.AllowImport ? new[] { "export", "import", "compile" } : args.AllowFixtureImport ? new[] { "export", "fixture-import", "compile" } : new[] { "export", "compile" };
            OpennessSession session = null;
            using (var owner = new OwnerThread(System.Threading.ApartmentState.STA))
            {
                var dispatcher = new RpcDispatcher(
                    () => session = OpennessSession.Attach(args, io.Emit),
                    new BridgeInfo(TiaVersion.Name, version, caps)) {
                        Diagnostics = Console.Error,
                        SessionProbe = () => OpennessSession.ProbeSession(args),
                        SessionAttach = () => session = OpennessSession.Attach(new BridgeArgs { ProjectPath = args.ProjectPath, SaveAfterImport = args.SaveAfterImport }, io.Emit),
                    };
                try { io.Run(dispatcher, owner); }
                finally { owner.Run(() => { session?.Dispose(); return 0; }).Wait(TimeSpan.FromSeconds(10)); }
            }
            return 0;
        }
    }
}
