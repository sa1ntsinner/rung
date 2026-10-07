// SPDX-License-Identifier: BUSL-1.1
using System;

namespace Rung.Bridge.Core.Protocol
{
    public static class RpcConstants
    {
        public const int ProtocolVersion = 1;
        public const int DefaultMaxLineLength = 16 * 1024 * 1024;
    }

    /// <summary>Wire error codes. Shared with packages/bridge-client/src/protocol.ts — keep in sync.</summary>
    public static class ErrorCodes
    {
        public const string TiaNotRunning = "TIA_NOT_RUNNING";
        public const string AmbiguousPortal = "AMBIGUOUS_PORTAL";
        public const string NoProject = "NO_PROJECT";
        public const string MultiuserUnsupported = "MULTIUSER_UNSUPPORTED";
        public const string AccessDenied = "ACCESS_DENIED";
        public const string NotFound = "NOT_FOUND";
        public const string ReadOnly = "READ_ONLY";
        public const string DownloadDisabled = "DOWNLOAD_DISABLED";
        public const string Inconsistent = "INCONSISTENT";
        public const string Busy = "BUSY";
        public const string ExportFailed = "EXPORT_FAILED";
        public const string ImportFailed = "IMPORT_FAILED";
        public const string PortalDisposed = "PORTAL_DISPOSED";
        public const string BadRequest = "BAD_REQUEST";
        public const string Internal = "INTERNAL";
        public const string StaleRevision = "STALE_REVISION";
        public const string StaleSnapshot = "STALE_SNAPSHOT";
        public const string DialogRequired = "DIALOG_REQUIRED";
        public const string UnsupportedCapability = "UNSUPPORTED_CAPABILITY";
        public const string UnsupportedObject = "UNSUPPORTED_OBJECT";
        public const string OutcomeUnknown = "OUTCOME_UNKNOWN";
        /// <summary>Creating an object whose name another object of the PLC already has (TIA names are unique per PLC, not per folder).</summary>
        public const string NameTaken = "NAME_TAKEN";
        /// <summary>Going online or downloading failed (not reachable, wrong interface, protection, ...).</summary>
        public const string OnlineFailed = "ONLINE_FAILED";
        /// <summary>The PLC has no connection target configured in rung.toml or TIA Portal.</summary>
        public const string NoTarget = "NO_TARGET";
        /// <summary>Moving the project into a TIA Portal window would close it with changes nobody allowed rung to save.</summary>
        public const string ProjectUnsaved = "PROJECT_UNSAVED";
        /// <summary>Another program holds the project in a TIA Portal without window; rung does not close it.</summary>
        public const string ProjectBusy = "PROJECT_BUSY";
        /// <summary>Another workspace still uses the keeper, so release would restart its Watch.</summary>
        public const string ProjectInUse = "PROJECT_IN_USE";
        /// <summary>The PLC asks for a password (access protection or a user) to go online, or did not take the one given.</summary>
        public const string PasswordRequired = "PASSWORD_REQUIRED";
        /// <summary>The PLC shows a TLS certificate TIA Portal does not trust yet; trusting it is the engineer's step in TIA Portal.</summary>
        public const string TlsUntrusted = "TLS_UNTRUSTED";
    }

    /// <summary>Nonfatal warning codes attached to results.</summary>
    public static class WarningCodes
    {
        public const string UnsupportedUnit = "UNSUPPORTED_UNIT";
        public const string Inconsistent = "INCONSISTENT";
        public const string SdFallback = "SD_FALLBACK";
        /// <summary>A tag table stays SimaticML: the text form (.tags.st) would lose something it holds.</summary>
        public const string TagsXmlFallback = "TAGS_XML_FALLBACK";
        /// <summary>TIA asked for a know-how password during the import; rung cancelled the prompt.</summary>
        public const string PasswordPromptCancelled = "PASSWORD_PROMPT_CANCELLED";
        /// <summary>The import is in TIA but saving the project failed; a TIA crash before the next save would lose it.</summary>
        public const string SaveFailed = "SAVE_FAILED";
    }

    public sealed class RpcException : Exception
    {
        public string Code { get; }
        public RpcException(string code, string message) : base(message) { Code = code; }
    }
}
