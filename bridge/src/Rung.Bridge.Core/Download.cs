// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Rung.Bridge.Core
{
    /// <summary>Where to connect: the names TIA shows in "Extended download / Go online".</summary>
    public sealed class ConnectionTarget
    {
        public string Mode;              // e.g. "PN/IE"
        public string PcInterface;       // e.g. "Intel(R) Ethernet Connection I219-LM" or "PLCSIM"
        public int PcInterfaceNumber = 1;
        public string TargetInterface;   // e.g. "1 X1"; null = the one TIA has configured
    }

    public sealed class OnlineStatus
    {
        public string Device;
        public string State;             // Offline | Connecting | Online | Incompatible | NotReachable | Protected | Disconnecting
    }

    public sealed class ConnectionOptions
    {
        public string Device;
        public bool Configured;
        /// <summary>Addresses the project gives the PLC's interfaces (e.g. PROFINET X1 = 192.168.0.1): what rung looks for on the network.</summary>
        public List<PlcAddressInfo> PlcAddresses = new List<PlcAddressInfo>();
        public List<ConnectionModeInfo> Modes = new List<ConnectionModeInfo>();
    }

    public sealed class PlcAddressInfo
    {
        public string Interface;
        public string Address;
        public string Subnet;
    }

    public sealed class ConnectionModeInfo
    {
        public string Name;
        public List<PcInterfaceInfo> PcInterfaces = new List<PcInterfaceInfo>();
    }

    public sealed class PcInterfaceInfo
    {
        public string Name;
        public int Number;
        public string[] TargetInterfaces;
        public string[] Subnets;
        /// <summary>Only filled when a network scan was requested.</summary>
        public List<AccessibleDeviceInfo> Accessible;
    }

    public sealed class AccessibleDeviceInfo
    {
        public string Name;
        public string Address;
        public string DeviceSeries;
        public string MacAddress;
    }

    public sealed class DownloadRequest
    {
        public string Device;
        public bool Hardware;
        public bool Software = true;
        public bool OnlyChanges = true;
        public string[] Allow = new string[0];
        public bool StartAfter = true;
        public ConnectionTarget Target;
    }

    /// <summary>One question TIA asked during the download and how rung answered it.</summary>
    public sealed class DownloadDecision
    {
        public string Phase;             // pre | post
        public string Kind;              // Openness type, e.g. StopModules
        public string Name;              // --allow name, e.g. stop-cpu
        public string Message;
        public string Choice;            // enum value chosen, or "checked"/"unchecked"/"password"
        public bool Allowed;
        public bool Blocks;              // this answer makes TIA cancel the download
    }

    public sealed class DownloadOutcome
    {
        public string Device;
        public string State;             // Success | Information | Warning | Error | Cancelled
        public int Errors;
        public int Warnings;
        public List<string> Messages = new List<string>();
        public List<DownloadDecision> Decisions = new List<DownloadDecision>();
        /// <summary>--allow names that would have let the download go ahead.</summary>
        public string[] NeedsAllow = new string[0];
    }

    /// <summary>
    /// Answers TIA's download questions (docs/decisions/0002-plc-actions.md). Default answer: the one that
    /// cancels the download. A question is accepted only when its name is allowed.
    /// </summary>
    public static class DownloadPolicy
    {
        public struct Decision
        {
            public string Name;
            public string Choice;
            public bool Allowed;
            public bool Blocks;
            public bool Checked;
        }

        sealed class Rule
        {
            public string Name;
            public string Safe;          // null: the safe answer is not risky, it simply proceeds
            public string Risky;
        }

        // kind → allow-name, safe answer (cancels) and the answer given when allowed
        static readonly Dictionary<string, Rule> Risky = new Dictionary<string, Rule>(StringComparer.Ordinal)
        {
            ["StopModules"] = new Rule { Name = "stop-cpu", Safe = "NoAction", Risky = "StopAll" },
            ["StopHSystemOrModule"] = new Rule { Name = "stop-cpu", Safe = "NoAction", Risky = "StopModule" },
            ["StopHSystem"] = new Rule { Name = "stop-h-system", Safe = "NoAction", Risky = "StopHSystem" },
            ["DataBlockReinitialization"] = new Rule { Name = "reinit-db", Safe = "NoAction", Risky = "StopPlcAndReinitialize" },
            ["InitializeMemory"] = new Rule { Name = "init-memory", Safe = "NoAction", Risky = "AcceptAll" },
            ["ResetModule"] = new Rule { Name = "reset-module", Safe = "NoAction", Risky = "DeleteAll" },
            ["OverwriteSystemData"] = new Rule { Name = "overwrite-system-data", Safe = "NoAction", Risky = "Overwrite" },
            ["DifferentTargetConfiguration"] = new Rule { Name = "different-target", Safe = "NoAction", Risky = "AcceptAll" },
            ["ActiveTestCanBeAborted"] = new Rule { Name = "abort-active-test", Safe = "NoAction", Risky = "AcceptAll" },
            ["ActiveTestCanPreventDownload"] = new Rule { Name = "abort-active-test", Safe = "NoAction", Risky = "AcceptAll" },
            ["ProtectionLevelChanged"] = new Rule { Name = "protection-level-changed", Safe = "NoChange", Risky = "ContinueDownloading" },
            ["OverwriteOnMemoryCard"] = new Rule { Name = "overwrite-memory-card", Safe = "NoAction", Risky = "Load" },
            ["SwitchBackupToPrimary"] = new Rule { Name = "switch-to-primary", Safe = "NoAction", Risky = "SwitchToPrimaryCpu" },
            ["SelectiveDeleteDownload"] = new Rule { Name = "selective-delete", Safe = null, Risky = "AcceptAll" },
        };

        // kind → the answer that simply lets the download go ahead
        static readonly Dictionary<string, string> Harmless = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ConsistentBlocksDownload"] = "ConsistentDownload",
            ["AllBlocksDownload"] = "DownloadAllBlocks",
            ["AlarmTextLibrariesDownload"] = "ConsistentDownload",
            ["ExpandDownload"] = "Download",
            ["LoadIdentificationData"] = "LoadNothing",
            ["TargetForSoftware"] = "CPU",
            ["WaitOnReboot"] = "Wait",
            ["UserManagementDownload"] = "KeepOnlineUserManagementData",
        };

        public static Decision Decide(string kind, string[] choices, IEnumerable<string> allow, bool startAfter)
        {
            var allowed = new HashSet<string>((allow ?? Enumerable.Empty<string>()).Select(Normalize), StringComparer.Ordinal);
            if (kind == "StartModules" || kind == "StartBackupModules")
            {
                var start = choices.Contains("StartModule") ? "StartModule" : choices.FirstOrDefault(c => c != "NoAction");
                return new Decision { Name = "start-cpu", Choice = startAfter && start != null ? start : "NoAction", Allowed = true, Blocks = false };
            }
            if (Harmless.TryGetValue(kind, out var go) && choices.Contains(go))
                return new Decision { Name = Kebab(kind), Choice = go, Allowed = true, Blocks = false };
            if (Risky.TryGetValue(kind, out var rule))
            {
                var ok = allowed.Contains(Normalize(rule.Name)) || allowed.Contains(Normalize(Kebab(kind)));
                if (ok && choices.Contains(rule.Risky)) return new Decision { Name = rule.Name, Choice = rule.Risky, Allowed = true, Blocks = false };
                var safe = rule.Safe != null && choices.Contains(rule.Safe) ? rule.Safe : SafestOf(choices);
                return new Decision { Name = rule.Name, Choice = safe, Allowed = false, Blocks = true };
            }
            // a question rung does not know: cancel unless the user allowed it by name
            var name = Kebab(kind);
            if (allowed.Contains(Normalize(name)))
                return new Decision { Name = name, Choice = choices.FirstOrDefault(c => c != "NoAction" && c != "NoChange") ?? choices.FirstOrDefault(), Allowed = true, Blocks = false };
            return new Decision { Name = name, Choice = SafestOf(choices), Allowed = false, Blocks = true };
        }

        /// <summary>Yes/no confirmations (DownloadCheckConfiguration): checked only when allowed by name.</summary>
        public static Decision DecideCheck(string kind, IEnumerable<string> allow)
        {
            var name = Kebab(kind);
            var ok = (allow ?? Enumerable.Empty<string>()).Select(Normalize).Contains(Normalize(name));
            return new Decision { Name = name, Checked = ok, Allowed = ok, Blocks = !ok, Choice = ok ? "checked" : "unchecked" };
        }

        static string SafestOf(string[] choices) =>
            choices.FirstOrDefault(c => c == "NoAction") ?? choices.FirstOrDefault(c => c == "NoChange") ?? choices.FirstOrDefault(c => c.StartsWith("Keep", StringComparison.Ordinal)) ?? choices.FirstOrDefault();

        static string Normalize(string s) => (s ?? "").Trim().ToLowerInvariant().Replace('_', '-').Replace(' ', '-');

        /// <summary>StopModules → stop-modules, ABCThing → abc-thing.</summary>
        public static string Kebab(string pascal)
        {
            var sb = new StringBuilder();
            for (var i = 0; i < pascal.Length; i++)
            {
                var c = pascal[i];
                var boundary = i > 0 && char.IsUpper(c) && (char.IsLower(pascal[i - 1]) || (i + 1 < pascal.Length && char.IsLower(pascal[i + 1])));
                if (boundary) sb.Append('-');
                sb.Append(char.ToLowerInvariant(c));
            }
            return sb.ToString();
        }
    }
}
