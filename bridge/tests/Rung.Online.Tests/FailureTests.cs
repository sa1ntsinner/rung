// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core.Protocol;
using Rung.Online;
using Xunit;

public sealed class FailureTests
{
    [Fact]
    public void SaysWhyANativeCaptureIsUnsupportedButHidesDriverText()
    {
        Assert.Equal((ErrorCodes.UnsupportedObject, "Native address scope is unsupported."), OnlineDispatcher.Failure(new NotSupportedException("Native address scope is unsupported.")));
        Assert.Equal((ErrorCodes.OnlineFailed, "Online request failed: " + ErrorCodes.OnlineFailed + "."), OnlineDispatcher.Failure(new IOException("secret password=1")));
    }
}
