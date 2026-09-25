// SPDX-License-Identifier: BUSL-1.1

/** Workspace-side error codes (the bridge has its own set in @rung/bridge-client). */
export type WorkspaceErrorCode =
  | "STATE_LOCKED"
  | "STATE_FORMAT"
  | "BINDING_MISMATCH"
  | "LOCAL_CHANGES"
  | "PATH_COLLISION"
  | "PATH_TOO_LONG"
  | "PATH_ESCAPE"
  | "RECOVERY_REQUIRED"
  | "CONFIG_INVALID"
  | "NOT_A_WORKSPACE";

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
