// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;

namespace Rung.Bridge.Core
{
    /// <summary>Everything the dispatcher needs from a TIA adapter. Implemented per TIA version.</summary>
    public interface ITiaSession
    {
        ProjectInfo GetProjectInfo();
        IReadOnlyList<ObjectEntry> ListObjects(string device);
        /// <param name="form">A TextForm or "auto" (FormPolicy).</param>
        ExportResult Export(string address, string form, string targetDir);
        /// <summary>Guarded import (fixture-only in M1). expectedTiaRevision = fingerprint the caller last exported, or "absent".</summary>
        ExportResult Import(string address, string form, string path, string expectedTiaRevision, string operationId);
        /// <summary>Compiles the given objects (or the whole PLC when addresses is empty) and flattens the messages.</summary>
        IReadOnlyList<CompileMessage> Compile(string device, string[] addresses);
        /// <summary>Guarded delete; expectedTiaRevision must match the current revision.</summary>
        void Delete(string address, string expectedTiaRevision, string operationId);
        /// <summary>Cross references reported by TIA Portal for one object.</summary>
        IReadOnlyList<XRefEntry> XRef(string address);
        /// <summary>Read-only attribute/composition tree for a scope: hardware, hmi or techobjects.</summary>
        DescribeNode Describe(string scope, int maxNodes);
    }

    public sealed class BridgeInfo
    {
        public string TiaVersion { get; }
        public string BridgeVersion { get; }
        public string[] Capabilities { get; }
        public BridgeInfo(string tiaVersion, string bridgeVersion, params string[] capabilities)
        {
            TiaVersion = tiaVersion; BridgeVersion = bridgeVersion; Capabilities = capabilities ?? new string[0];
        }
    }

    public static class Bundle
    {
        public static string Sha256(byte[] data)
        {
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(data).Select(b => b.ToString("x2")));
        }

        /// <summary>Hash of sorted role/byte-hash pairs; independent of staging paths.</summary>
        public static string Hash(IEnumerable<ExportFile> files)
        {
            var lines = files.Select(f => f.Role + "\t" + f.Sha256).OrderBy(s => s, StringComparer.Ordinal);
            return Sha256(new UTF8Encoding(false).GetBytes(string.Join("\n", lines)));
        }
    }

    public sealed class PortalCandidate
    {
        public int Pid { get; }
        public string ProjectPath { get; }
        public PortalCandidate(int pid, string projectPath) { Pid = pid; ProjectPath = projectPath; }
    }

    /// <summary>Pure selection of the TIA process to attach to. Never guesses between several projects.</summary>
    public static class PortalSelector
    {
        public static PortalCandidate Choose(IList<PortalCandidate> processes, string wantedPath)
        {
            if (processes == null || processes.Count == 0)
                throw new RpcException(ErrorCodes.TiaNotRunning, "No TIA Portal process is running.");
            var withProject = processes.Where(p => !string.IsNullOrEmpty(p.ProjectPath)).ToList();
            List<PortalCandidate> matches;
            if (!string.IsNullOrEmpty(wantedPath))
            {
                var want = Normalize(LooksAbsolute(wantedPath) ? wantedPath : System.IO.Path.GetFullPath(wantedPath));
                matches = withProject.Where(p => string.Equals(Normalize(p.ProjectPath), want, StringComparison.OrdinalIgnoreCase)).ToList();
                if (matches.Count == 0) throw new RpcException(ErrorCodes.NoProject, "Project is not open in any TIA Portal instance: " + wantedPath);
            }
            else
            {
                matches = withProject;
                if (matches.Count == 0) throw new RpcException(ErrorCodes.NoProject, "No TIA Portal instance has a project open.");
            }
            if (matches.Count > 1)
                throw new RpcException(ErrorCodes.AmbiguousPortal, "Several TIA Portal instances match: " + string.Join(", ", matches.Select(m => m.Pid + "=" + m.ProjectPath)));
            return matches[0];
        }

        // Windows drive/UNC paths count as absolute on every OS (tests run on Linux too).
        static bool LooksAbsolute(string p) => System.IO.Path.IsPathRooted(p) || System.Text.RegularExpressions.Regex.IsMatch(p, @"^([A-Za-z]:[/\\]|[/\\]{2})");

        static string Normalize(string p) => p.Replace('/', '\\').TrimEnd('\\');
    }

    public static class FormPolicy
    {
        public static string Choose(ObjectEntry e, FormCapabilities caps)
        {
            if (e.KnowHowProtected) return "protected.yaml";
            switch (e.Kind)
            {
                case "type": return e.IsFailsafe ? "xml" : "udt";
                case "tagtable": return "tags.xml";
                case "block": break;
                default: return "xml";
            }
            var isDb = e.BlockType == "GlobalDB" || e.BlockType == "InstanceDB" || e.BlockType == "ArrayDB" || e.Language == "DB";
            if (isDb) return e.IsFailsafe ? "xml" : "db";
            var lang = (e.Language ?? "").StartsWith("F_", StringComparison.Ordinal) ? e.Language.Substring(2) : e.Language;
            switch (lang)
            {
                case "SCL": return "scl";
                case "STL": return caps.SourceStl ? "awl" : "xml";
                case "LAD": return caps.SdLad ? "s7dcl" : "xml";
                case "FBD": return caps.SdFbd ? "s7dcl" : "xml";
                default: return "xml";
            }
        }

        /// <summary>v1: protected, failsafe, system and GRAPH objects are never imported.</summary>
        public static bool IsReadOnly(ObjectEntry e) =>
            e.KnowHowProtected || e.IsFailsafe || e.IsSystem ||
            (e.Language ?? "").IndexOf("GRAPH", StringComparison.Ordinal) >= 0;
    }
}
