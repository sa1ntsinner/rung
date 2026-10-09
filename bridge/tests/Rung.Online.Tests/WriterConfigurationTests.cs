// SPDX-License-Identifier: BUSL-1.1
using System.Security.Cryptography;
using Rung.Online;
using Rung.Bridge.Core.Protocol;
using Xunit;

public sealed class WriterConfigurationTests
{
    [Fact]
    public void BrokerStartupPolicyCannotRetargetOrIgnoreAChangedConfiguration()
    {
        var directory = Path.Combine(Path.GetTempPath(), "rung-write-policy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "rung.toml"); File.WriteAllText(file, "fixture config");
        try {
            var policy = new WriterConfiguration(directory, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))), "P", "192.168.250.1", new string('A', 64), true);
            var request = new ConnectRequest("P", "192.168.250.1", new string('A', 64));
            policy.Verify(request);
            Assert.Equal(ErrorCodes.TargetRefused, Assert.Throws<RpcException>(() => policy.Verify(request with { Address = "192.168.1.1" })).Code);
            Assert.Equal(ErrorCodes.StalePreparation, Assert.Throws<RpcException>(() => policy.Verify(request with { Device = "Other" })).Code);
            File.WriteAllText(file, "changed config");
            Assert.Equal(ErrorCodes.StalePreparation, Assert.Throws<RpcException>(() => policy.Verify(request)).Code);
        } finally { File.Delete(file); Directory.Delete(directory); }
    }
}
