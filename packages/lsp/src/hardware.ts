// SPDX-License-Identifier: BUSL-1.1
import { parseDocument } from "yaml";

/** Text boundary shared by hardware CLI and editor tooling; host owns the domain schema. */
export function hardwarePatchText(text: string): string {
  if (Buffer.byteLength(text, "utf8") > 1048576) throw new Error("Hardware patch exceeds 1 MiB");
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* block YAML below */ }
  if (json !== undefined) {
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Hardware patch must be a mapping");
    return text; // preserve duplicate JSON keys for the host's strict parser
  }
  const doc = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error((doc.errors[0] ?? doc.warnings[0])!.message);
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hardware patch must be a mapping");
  return JSON.stringify(value);
}
