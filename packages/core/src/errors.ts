// SPDX-License-Identifier: BUSL-1.1

/** Workspace-side error codes (the bridge has its own set in @rung/bridge-client). */
export type WorkspaceErrorCode =
  | "STATE_LOCKED"
  | "NOT_MIRRORED"
  | "NO_TARGET"
  | "STATE_FORMAT"
  | "BINDING_MISMATCH"
  | "LOCAL_CHANGES"
  | "PATH_COLLISION"
  | "PATH_TOO_LONG"
  | "PATH_ESCAPE"
  | "RECOVERY_REQUIRED"
  | "CONFIG_INVALID"
  /** the command line asks for something that does not fit (a wrong name, a missing choice) */
  | "BAD_ARGUMENT"
  /** resolve / confirm-delete on an object that has nothing to resolve or delete */
  | "NOTHING_PENDING"
  | "CONFLICT_MARKERS"
  /** rung watch is starting and has no bridge yet */
  | "NOT_READY"
  /** an FB to monitor has no single instance DB: the person names the instance */
  | "NO_INSTANCE"
  | "BRIDGE_UNREACHABLE"
  | "NOT_A_WORKSPACE"
  | "READ_ONLY"
  /** this copy of the workspace was not given the right to write into its project (rung writes on) */
  | "WRITES_OFF";

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
