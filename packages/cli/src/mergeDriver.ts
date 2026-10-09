// SPDX-License-Identifier: BUSL-1.1
// rung merge-driver %O %A %B %P: git's merge of a PLC source. Line by line as git merges, except that declarations
// both branches added to a VAR section, and test cases both added, all stay (no conflict). Configured with
//   git config merge.rung.driver "rung merge-driver %O %A %B %P"   and   *.scl merge=rung   in .gitattributes
// The result goes into %A, as git wants it; exit 1 leaves conflict markers there for the person.
import { readFile, writeFile } from "node:fs/promises";
import { mergeSource } from "@rung/sync";
import type { Io } from "./common.js";

export async function cmdMergeDriver(args: string[], io: Io): Promise<number> {
  const [base, ours, theirs, path] = args;
  if (!base || !ours || !theirs) {
    io.stderr("rung: usage: rung merge-driver <base> <ours> <theirs> [<path>]   (git runs it: merge.rung.driver = rung merge-driver %O %A %B %P)\n");
    return 2;
  }
  const r = mergeSource(await readFile(base, "utf8"), await readFile(ours, "utf8"), await readFile(theirs, "utf8"), path ?? ours);
  await writeFile(ours, r.text);
  return r.kind === "clean" ? 0 : 1;
}
