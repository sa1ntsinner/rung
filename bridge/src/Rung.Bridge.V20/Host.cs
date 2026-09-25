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
            var caps = args.AllowFixtureImport ? new[] { "export", "fixture-import" } : new[] { "export" };
            OpennessSession session = null;
            using (var owner = new OwnerThread())
            {
                var dispatcher = new RpcDispatcher(
                    () => session = OpennessSession.Attach(args, io.Emit),
                    new BridgeInfo("V20", version, caps)) { Diagnostics = Console.Error };
                try { io.Run(dispatcher, owner); }
                finally { owner.Run(() => { session?.Dispose(); return 0; }).Wait(TimeSpan.FromSeconds(10)); }
            }
            return 0;
        }
    }
}
