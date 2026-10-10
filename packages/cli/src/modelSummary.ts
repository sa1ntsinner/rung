// SPDX-License-Identifier: BUSL-1.1
import type { DescribeNode } from "@rung/bridge-client";

/** Display only engineering identity fields; raw metadata remains available with --json. */
export function modelSummary(tree: DescribeNode, title: string, revision?: string): string {
  const lines = [title, ...(revision ? [`Revision: ${revision}`] : [])];
  let count = 0, limited = false, incomplete = false;
  const seen = new Set<DescribeNode>();
  const walk = (node: DescribeNode, depth: number) => {
    if (!node || depth > 12 || seen.has(node)) { incomplete = true; return; }
    if (count >= 200) { limited = true; return; }
    seen.add(node); count++;
    if (node.truncated) incomplete = true;
    const a = node.attributes ?? {};
    const fields = ["TypeName", "Classification", "OrderNumber", "PositionNumber", "FirmwareVersion", "Address", "VersionNumber", "State", "Status", "Guid", "LibraryType"]
      .filter(key => a[key] && a[key] !== "None")
      .map(key => `${key.replace(/([a-z])([A-Z])/g, "$1 $2")}: ${a[key]}`);
    if (node.name || a.Name || fields.length) lines.push(`${"  ".repeat(depth)}${node.name ?? a.Name ?? "(unnamed)"}${fields.length ? ` — ${fields.join("; ")}` : ""}`);
    for (const children of Object.values(node.children ?? {})) for (const child of children) walk(child, depth + 1);
  };
  walk(tree, 0);
  if (incomplete) lines.push("Snapshot incomplete: some objects were unavailable or truncated.");
  if (limited) lines.push("Summary limited to 200 objects.");
  lines.push("Use --json for the full returned tree and metadata.");
  return lines.join("\n") + "\n";
}
