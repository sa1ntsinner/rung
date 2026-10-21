// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using Microsoft.Win32;

namespace Rung.Bridge.V20
{
    /// <summary>
    /// Where the TIA Portal setup registered the Openness API:
    /// HKLM\SOFTWARE\Siemens\Automation\Openness\&lt;20.0&gt;\PublicAPI\&lt;20.0.0.0&gt;, value "Siemens.Engineering" = the dll's path
    /// (V21: subkey net48, value "Siemens.Engineering.Base"). Touches no Siemens type, so it can run before AssemblyResolve.
    /// </summary>
    public static class OpennessDir
    {
        /// <param name="tia">"20.0"</param>
        /// <param name="value">the value naming the dll, optionally behind a subkey: "Siemens.Engineering" or @"net48\Siemens.Engineering.Base"</param>
        public static string FromRegistry(string tia, string value)
        {
            try
            {
                var cut = value.LastIndexOf('\\');
                var sub = cut < 0 ? "" : "\\" + value.Substring(0, cut);
                var name = cut < 0 ? value : value.Substring(cut + 1);
                var assembly = tia.Substring(0, tia.IndexOf('.')) + ".0.0.0";
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var key = hklm.OpenSubKey($@"SOFTWARE\Siemens\Automation\Openness\{tia}\PublicAPI\{assembly}{sub}"))
                {
                    var dll = key?.GetValue(name) as string;
                    if (string.IsNullOrEmpty(dll) || !File.Exists(dll)) return null;
                    return Path.GetDirectoryName(dll);
                }
            }
            catch (Exception e) when (e is System.Security.SecurityException || e is UnauthorizedAccessException || e is IOException || e is ArgumentException)
            {
                return null;
            }
        }
    }
}
