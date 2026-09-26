// SPDX-License-Identifier: BUSL-1.1
// Wire DTOs. Field names are serialized camelCase; null fields are omitted.
// Mirror: packages/bridge-client/src/protocol.ts.

namespace Rung.Bridge.Core.Model
{
    public sealed class ProjectInfo
    {
        public string Name;
        public string Path;
        public string TiaVersion;
        public string[] Devices;
        public bool IsLocalSession;
        public string[] Units;
    }

    public sealed class ObjectEntry
    {
        public string Address;
        public string Kind;          // block | type | tagtable | techobject | watchtable | forcetable
        public string Language;      // PlcBlock.ProgrammingLanguage.ToString(), null for non-blocks
        public string BlockType;     // FB | FC | OB | GlobalDB | InstanceDB | ArrayDB
        public int? Number;
        public string Namespace;
        public string Unit;
        public bool KnowHowProtected;
        public bool IsFailsafe;
        public bool IsSystem;
        public bool? IsConsistent;
        public string Fingerprint;   // "fp:..." strong, "dt:..." weak, "none" = must hash
        public string[] Warnings;
    }

    public sealed class ExportFile
    {
        public string Path;          // absolute staged path
        public string Role;          // "primary" or a companion role such as "res:en-US"
        public string Sha256;        // lowercase hex of the (normalized) bytes
    }

    public sealed class ExportResult
    {
        public string Address;
        public string Form;
        public ExportFile[] Files;
        public string[] Warnings;
        public string Fingerprint;   // revision the bytes belong to
        public string BundleHash;
    }

    public sealed class CompileMessage
    {
        public string Address;
        public string Severity;      // error | warning | info
        public string Path;
        public string Description;
        public int? Line;
        public int? Column;
    }

    public sealed class XRefEntry
    {
        public string Source;        // our address of the referencing object
        public string SourceName;
        public string Target;        // our address of the referenced object, null for tags/system objects not in the inventory
        public string TargetName;
        public string TargetType;
        public string TargetAddress; // e.g. %I0.0 for tags
        public string Access;        // Read, Write, ReadWrite, Call, ...
        public string ReferenceType; // Uses, UsedBy, TypeInstance, ...
        public string Location;      // e.g. NW 2 or line information as TIA reports it
    }

    public sealed class DescribeNode
    {
        public string Type;
        public string Name;
        public System.Collections.Generic.SortedDictionary<string, string> Attributes;
        public System.Collections.Generic.SortedDictionary<string, System.Collections.Generic.List<DescribeNode>> Children;
        public bool? Truncated;
    }

    public sealed class FormCapabilities
    {
        public bool SdLad;
        public bool SdFbd;
        public bool SourceStl = true;
    }
}
