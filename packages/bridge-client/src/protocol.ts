// SPDX-License-Identifier: MIT
// Wire contract with rung-bridge. Mirror: bridge/src/Rung.Bridge.Core/{Model,Protocol}.

export const PROTOCOL_VERSION = 1;

export const ErrorCodes = {
  TIA_NOT_RUNNING: "TIA_NOT_RUNNING",
  AMBIGUOUS_PORTAL: "AMBIGUOUS_PORTAL",
  NO_PROJECT: "NO_PROJECT",
  MULTIUSER_UNSUPPORTED: "MULTIUSER_UNSUPPORTED",
  ACCESS_DENIED: "ACCESS_DENIED",
  NOT_FOUND: "NOT_FOUND",
  READ_ONLY: "READ_ONLY",
  DOWNLOAD_DISABLED: "DOWNLOAD_DISABLED",
  INCONSISTENT: "INCONSISTENT",
  BUSY: "BUSY",
  EXPORT_FAILED: "EXPORT_FAILED",
  IMPORT_FAILED: "IMPORT_FAILED",
  PORTAL_DISPOSED: "PORTAL_DISPOSED",
  BAD_REQUEST: "BAD_REQUEST",
  INTERNAL: "INTERNAL",
  STALE_REVISION: "STALE_REVISION",
  STALE_SNAPSHOT: "STALE_SNAPSHOT",
  DIALOG_REQUIRED: "DIALOG_REQUIRED",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  UNSUPPORTED_OBJECT: "UNSUPPORTED_OBJECT",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  NAME_TAKEN: "NAME_TAKEN",
  ONLINE_FAILED: "ONLINE_FAILED",
  NO_TARGET: "NO_TARGET",
  // client-side only
  BRIDGE_EXITED: "BRIDGE_EXITED",
  TIMEOUT: "TIMEOUT",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
} as const;

export const WarningCodes = {
  UNSUPPORTED_UNIT: "UNSUPPORTED_UNIT",
  INCONSISTENT: "INCONSISTENT",
  SD_FALLBACK: "SD_FALLBACK",
  /** a tag table stays .tags.xml: the text form would lose something it holds */
  TAGS_XML_FALLBACK: "TAGS_XML_FALLBACK",
  /** TIA asked for a know-how password during an import (project has protected blocks); rung cancelled it. */
  PASSWORD_PROMPT_CANCELLED: "PASSWORD_PROMPT_CANCELLED",
  /** the import is in TIA, but saving the project failed */
  SAVE_FAILED: "SAVE_FAILED",
} as const;

export class BridgeError extends Error {
  override name = "BridgeError";
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HelloResult {
  protocol: number;
  tiaVersion: string;
  bridgeVersion: string;
  capabilities: string[];
}

export interface ProjectInfo {
  name: string;
  path: string;
  tiaVersion: string;
  devices: string[];
  isLocalSession: boolean;
  units?: string[];
}

export interface ObjectEntry {
  address: string;
  kind: string;
  language?: string;
  blockType?: string;
  number?: number;
  namespace?: string;
  unit?: string;
  knowHowProtected: boolean;
  isFailsafe: boolean;
  isSystem: boolean;
  isConsistent?: boolean;
  /** "LGF_FloatingAverage 3.0.2" for an instance of a library type: read-only, TIA Portal's library owns it */
  libraryType?: string;
  /** "fp:..." strong revision, "dt:..." weak, "none" = always verify by hash. */
  fingerprint: string;
  /** The modification dates and consistency the fingerprint belongs to, and when the bridge read it. */
  revisionKey?: string;
  revisionAt?: string;
  warnings?: string[];
}

/** An object's revision from an earlier listing: objects.list reads only those whose dates changed since. */
export interface KnownRevision {
  key: string;
  fingerprint: string;
  at: string;
  libraryType?: string;
}

export interface ExportFile {
  path: string;
  role: string;
  sha256: string;
  /** The text, when files cross the connection (a bridge on another machine); `path` is then the file name. */
  content?: string;
}

export interface ExportResult {
  address: string;
  form: string;
  files: ExportFile[];
  warnings: string[];
  fingerprint: string;
  bundleHash: string;
  /** An import's answer: what TIA Portal's compile of the imported object said (absent from bridges that do not tell). */
  compile?: CompileMessage[];
}

export interface XRefEntry {
  source: string;
  sourceName: string;
  target?: string;
  targetName: string;
  targetType: string;
  targetAddress?: string;
  access: string;
  referenceType: string;
  location?: string;
}

export interface DescribeNode {
  type: string;
  name?: string;
  attributes: Record<string, string>;
  children: Record<string, DescribeNode[]>;
  truncated?: boolean;
}

export interface CompileMessage {
  address?: string;
  severity: "error" | "warning" | "info";
  path?: string;
  description: string;
  line?: number;
  column?: number;
  /** line counted from the line after BEGIN, as TIA reports it */
  bodyLine?: number;
  /** "body" or "interface" */
  section?: string;
}

/** Where to connect; names as TIA shows them in "Extended download" (docs/downloads.md). */
export interface ConnectionTarget {
  mode: string;
  pcInterface: string;
  pcInterfaceNumber?: number;
  targetInterface?: string;
}

export interface OnlineStatus {
  device: string;
  state: "Offline" | "Connecting" | "Online" | "Incompatible" | "NotReachable" | "Protected" | "Disconnecting" | string;
}

/** The project against the PLC, like TIA's online/offline comparison. */
export interface CompareOutcome {
  device: string;
  /** Openness state of the root, e.g. FolderContentsIdentical */
  state: string;
  /** objects that are the same in the project and on the PLC */
  identical: number;
  items: CompareItem[];
}

export interface CompareItem {
  /** TIA's tree path, e.g. "Program blocks/Drives/FB_Pump" */
  path: string;
  name: string;
  state: "Different" | "OnlyInProject" | "OnlyOnPlc" | string;
  detail?: string | null;
  /** workspace address when rung mirrors the object */
  address?: string | null;
}

export interface AccessibleDevice {
  name: string;
  address: string;
  deviceSeries: string;
  macAddress: string;
}

export interface ConnectionOptions {
  device: string;
  configured: boolean;
  /** addresses the project gives the CPU's interfaces, e.g. { interface: "PROFINET interface_1", address: "192.168.0.1" } */
  plcAddresses: { interface: string; address: string; subnet?: string }[];
  modes: { name: string; pcInterfaces: { name: string; number: number; targetInterfaces: string[]; subnets: string[]; accessible?: AccessibleDevice[] }[] }[];
}

export interface DownloadRequest {
  device: string;
  hardware?: boolean;
  software?: boolean;
  onlyChanges?: boolean;
  allow?: string[];
  startAfter?: boolean;
  target: ConnectionTarget;
}

export interface DownloadDecision {
  phase: "pre" | "post";
  kind: string;
  name: string;
  message?: string;
  choice: string;
  allowed: boolean;
  blocks: boolean;
}

export interface DownloadOutcome {
  device: string;
  state: "Success" | "Information" | "Warning" | "Error" | "Cancelled" | string;
  errors: number;
  warnings: number;
  messages: string[];
  decisions: DownloadDecision[];
  needsAllow: string[];
}

/** TIA Portal's "Upload device as new station"; a read password comes from RUNG_PLC_PASSWORD in the bridge's environment. */
export interface UploadRequest {
  /** The PLC's IP address. */
  address: string;
  mode?: string;
  /** Default: the only PG/PC interface of the mode. */
  pcInterface?: string;
  pcInterfaceNumber?: number;
}

export interface UploadOutcome {
  state: "Success" | "Information" | "Warning" | "Error" | string;
  station?: string;
  /** PLCs of the new station (plc/<name>/ after a pull). */
  plcs: string[];
  messages: string[];
  /** The station was uploaded but the project could not be saved. */
  saveError?: string;
  /** With saveError: the station was taken out of the project again, which is as it was before. */
  stationRemoved?: boolean;
}

export interface BridgeEvent {
  event: string;
  params: unknown;
}
