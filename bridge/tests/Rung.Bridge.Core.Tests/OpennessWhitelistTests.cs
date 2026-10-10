// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class OpennessWhitelistTests
{
    [Fact]
    public void UiAttachmentCanShowTheAccessPromptWithoutReadingRegistration()
    {
        OpennessWhitelist.Require("not-a-file.exe", "20.0", (key, name) => throw new Exception("UI must keep the TIA access prompt"), hasWindow: true);
    }

    [Theory]
    [InlineData("20.0", "20.0\\Whitelist")]
    [InlineData("21.0", "AllowList")]
    public void MatchingRegistrationAllowsStartup(string version, string branch)
    {
        WithFile(file => {
            OpennessWhitelist.Require(file, version, (key, name) => {
                Assert.Contains("\\" + branch + "\\" + Path.GetFileName(file) + "\\Entry", key);
                return Value(file, name);
            });
            OpennessWhitelist.Require(file, version, (key, name) => name == "Path" ? Path.GetDirectoryName(file) : Value(file, name));
        });
    }

    [Theory]
    [InlineData("Path")]
    [InlineData("FileHash")]
    [InlineData("DateModified")]
    [InlineData("missing")]
    public void MissingOrStaleRegistrationRefusesBeforeStartup(string stale)
    {
        WithFile(file => {
            var e = Assert.Throws<RpcException>(() => OpennessWhitelist.Require(file, "20.0", (key, name) =>
                stale == "missing" ? null : name == stale ? "old" : Value(file, name)));
            Assert.Equal(ErrorCodes.AccessDenied, e.Code);
            Assert.Contains("rung setup openness", e.Message);
            Assert.Contains(file, e.Message);
        });
    }

    static string Value(string file, string name)
    {
        if (name == "Path") return file;
        if (name == "DateModified") return File.GetLastWriteTimeUtc(file).ToString("yyyy/MM/dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
        using (var hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(File.ReadAllBytes(file)));
    }
    static void WithFile(Action<string> test)
    {
        var file = Path.GetTempFileName();
        try { File.WriteAllText(file, "bridge"); test(file); }
        finally { File.Delete(file); }
    }
}
