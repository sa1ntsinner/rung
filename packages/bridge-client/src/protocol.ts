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
  // client-side only
  BRIDGE_EXITED: "BRIDGE_EXITED",
  TIMEOUT: "TIMEOUT",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
} as const;

export const WarningCodes = {
  UNSUPPORTED_UNIT: "UNSUPPORTED_UNIT",
  INCONSISTENT: "INCONSISTENT",
  SD_FALLBACK: "SD_FALLBACK",
  /** TIA asked for a know-how password during an import (project has protected blocks); rung cancelled it. */
  PASSWORD_PROMPT_CANCELLED: "PASSWORD_PROMPT_CANCELLED",
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
  /** "fp:..." strong revision, "dt:..." weak, "none" = always verify by hash. */
  fingerprint: string;
  warnings?: string[];
}

export interface ExportFile {
  path: string;
  role: string;
  sha256: string;
}

export interface ExportResult {
  address: string;
  form: string;
  files: ExportFile[];
  warnings: string[];
  fingerprint: string;
  bundleHash: string;
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
  /** line counted from the line after BEGIN, as TIA reports it (fact F7) */
  bodyLine?: number;
  /** "body" or "interface" */
  section?: string;
}

export interface BridgeEvent {
  event: string;
  params: unknown;
}
