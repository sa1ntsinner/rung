// SPDX-License-Identifier: BUSL-1.1
export const RUNG_FORMAT_VERSION = 1 as const;

export { AddressError, escapeSegment, unescapeSegment, leafSegment, splitLeaf } from "./escape.js";
export {
  type Address,
  type ObjectKind,
  type TextForm,
  KIND_DIR,
  FORMS_BY_KIND,
  formatAddress,
  parseAddress,
  addressToPath,
  addressToStem,
  pathToAddress,
  ignoredSourceReason,
  findCaseCollisions,
} from "./address.js";
export { WorkspaceError, type WorkspaceErrorCode } from "./errors.js";
export { sha256, normalizeText, writeFileAtomic, replaceGuarded, type GuardOptions, type GuardResult } from "./atomic.js";
export { StateStore, type ObjectState, type ObjectStatus, type StateFile, type Binding } from "./state.js";
export { BlobStore, Journal, publishBundle, recoverJournal, bundleHash, pathKey, writeRecoveryNote, type PublishIntent, type PublishTarget, type RecoveryReport } from "./bundle.js";
export { type RungConfig, type EngineeringVersion, ENGINEERING_VERSIONS, CONFIG_FILE, defaultConfig, parseConfig, formatConfig, loadConfig, saveConfig } from "./config.js";
export { preflight, isContained, sweepTempFiles, MAX_ABSOLUTE_PATH, type PlannedPath, type PreflightResult } from "./layout.js";
export { toYaml } from "./yaml.js";
export * from "./check.js";
export { splitNetworks, networkKey, blankIds, renumberIds, type NetworkForm, type NetworkSplit } from "./networks.js";
