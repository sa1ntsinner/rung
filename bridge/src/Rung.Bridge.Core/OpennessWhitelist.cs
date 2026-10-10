// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    public static class OpennessWhitelist
    {
        // Headless TIA cannot show its Openness prompt, on startup or on attachment.
        public static void Require(string exe, string version, Func<string, string, string> readValue, bool hasWindow = false)
        {
            if (hasWindow) return;
            var branch = int.Parse(version.Split('.')[0], CultureInfo.InvariantCulture) >= 21 ? "AllowList" : version + @"\Whitelist";
            var key = @"HKEY_LOCAL_MACHINE\SOFTWARE\Siemens\Automation\Openness\" + branch + "\\" + Path.GetFileName(exe) + @"\Entry";
            var path = readValue(key, "Path");
            var date = readValue(key, "DateModified");
            var registeredHash = readValue(key, "FileHash");
            string hash;
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(exe)) hash = Convert.ToBase64String(sha.ComputeHash(stream));
            var samePath = string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)
                || string.Equals(path?.TrimEnd('\\', '/'), Path.GetDirectoryName(exe)?.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
            if (!samePath || registeredHash != hash || date != File.GetLastWriteTimeUtc(exe).ToString("yyyy/MM/dd HH:mm:ss.fff", CultureInfo.InvariantCulture))
                throw new RpcException(ErrorCodes.AccessDenied, "Openness registration is missing or stale for " + exe
                    + ". Run: rung setup openness. Unattended TIA access was refused; a background TIA cannot display the access prompt.");
        }
    }
}
