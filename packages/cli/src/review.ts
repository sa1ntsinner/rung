// SPDX-License-Identifier: BUSL-1.1
import { reviewChanges, reviewMarkdown } from "@rung/mcp";
import { findWorkspace, type Io } from "./common.js";

export async function cmdReview(range: string | undefined, options: { base?: string; head?: string; json?: boolean; md?: boolean }, io: Io): Promise<number> {
  if (range && options.base) throw new Error("Use a revision range or --base, not both");
  if (options.json && options.md) throw new Error("Use --json or --md, not both");
  const root = await findWorkspace(io.cwd).catch(() => io.cwd);
  const report = await reviewChanges(root, { base: range ?? options.base, head: options.head });
  io.stdout(options.json ? JSON.stringify(report, null, 2) + "\n" : reviewMarkdown(report));
  return 0;
}
