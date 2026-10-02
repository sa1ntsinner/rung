// SPDX-License-Identifier: MIT
// What rung sync --preview --json says, in the words the Preview Sync list shows.

export interface PlanEntry {
  address: string;
  path: string;
  action: "create" | "update" | "merge" | "export" | "remove" | "restore" | "conflict" | "pending-delete";
  before?: string;
  after?: string;
  detail?: string;
}

export interface PreviewReport {
  plan?: { entries: PlanEntry[]; compile: string[] };
  writesOff?: boolean;
}

/** The JSON the CLI printed (TIA Portal's own messages may come before it on stderr). */
export function parsePreview(output: string): PreviewReport | undefined {
  const at = output.search(/^\{/m);
  if (at < 0) return undefined;
  try {
    return JSON.parse(output.slice(at)) as PreviewReport;
  } catch {
    return undefined;
  }
}

export const SENT = new Set(["create", "update", "merge"]);

export const ICON: Record<PlanEntry["action"], string> = {
  create: "add",
  update: "arrow-right",
  merge: "git-merge",
  export: "arrow-left",
  remove: "trash",
  restore: "history",
  conflict: "warning",
  "pending-delete": "circle-slash",
};

/** Plain words for an entry: where it goes. */
export function describe(e: PlanEntry): { label: string; description: string } {
  const file = e.path.split("/").pop() ?? e.path;
  switch (e.action) {
    case "create":
      return { label: `${file} → TIA Portal`, description: "new block" };
    case "update":
      return { label: `${file} → TIA Portal`, description: "your edit" };
    case "merge":
      return { label: `${file} → TIA Portal`, description: "your edit merged with TIA Portal's change" };
    case "export":
      return { label: `TIA Portal → ${file}`, description: "changed in TIA Portal" };
    case "restore":
      return { label: `TIA Portal → ${file}`, description: "the file comes back" };
    case "remove":
      return { label: file, description: "deleted in TIA Portal: the file goes" };
    case "conflict":
      return { label: file, description: "changed here and in TIA Portal on the same lines: nothing is sent" };
    case "pending-delete":
      return { label: file, description: "deleted here: rung confirm-delete deletes it in TIA Portal" };
  }
}
