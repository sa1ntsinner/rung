// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public static class CompileFailure
    {
        public static RpcException Refused(string reason) => new RpcException(ErrorCodes.TargetRefused,
            "TIA refused compilation: " + reason + " Check diagnostics and project/safety permissions in TIA Portal; rung cannot grant permissions.");
    }
}
