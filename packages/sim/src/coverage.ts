// SPDX-License-Identifier: BUSL-1.1
// Statement coverage of `rung test`: which lines of SCL ran in the simulator, over every case of a run, as
// lcov (`rung test --coverage`, CI tools, the VS Code test explorer). Every block with code the simulator
// runs counts, tested or not, so the number says how much of the program the tests reach.
// ponytail: lines, not branches; an IF's condition line counts as run when the IF ran.
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import type { WorkspaceIndex } from "@rung/lsp";
import { Simulator } from "./runtime.js";

export interface FileCoverage {
  uri: string;
  /** Executable lines (1-based) and how often a statement on them ran. */
  lines: Map<number, number>;
}

export class Coverage {
  /** Statements run, by file and line. */
  private readonly hits = new Map<string, Map<number, number>>();

  /** Counts the statements this simulator runs (keeps a hook that was there). */
  attach(sim: Simulator): void {
    const before = sim.onStatement;
    sim.onStatement = (s, f) => {
      before?.(s, f);
      const at = sim.locationOf(f, s.at);
      if (!at) return;
      let lines = this.hits.get(at.uri);
      if (!lines) this.hits.set(at.uri, (lines = new Map()));
      lines.set(at.line, (lines.get(at.line) ?? 0) + 1);
    };
  }

  /** Every file with simulated code, each executable line with its count (0: never ran). */
  files(index: WorkspaceIndex): FileCoverage[] {
    const sim = new Simulator(index);
    const out: FileCoverage[] = [];
    for (const doc of index.docs.values()) {
      const lines = new Map<number, number>();
      const hit = this.hits.get(doc.uri);
      for (const b of doc.parsed?.blocks ?? []) {
        if (b.lad !== undefined) continue; // runs as translated text: no lines of its own
        for (const s of sim.statementsOf(b)) {
          if (s.k === "label" || s.k === "empty") continue;
          const line = doc.lines.position(s.at).line + 1;
          lines.set(line, hit?.get(line) ?? 0);
        }
      }
      if (lines.size) out.push({ uri: doc.uri, lines });
    }
    return out.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  /** lcov tracefile, paths relative to the workspace (as CI tools and editors expect). */
  static lcov(files: FileCoverage[], root: string): string {
    return files
      .map((f) => {
        const lines = [...f.lines].sort((a, b) => a[0] - b[0]);
        const path = relative(root, fileURLToPath(f.uri)).split("\\").join("/");
        return [`SF:${path}`, ...lines.map(([l, n]) => `DA:${l},${n}`), `LH:${lines.filter(([, n]) => n > 0).length}`, `LF:${lines.length}`, "end_of_record"].join("\n");
      })
      .join("\n") + (files.length ? "\n" : "");
  }

  /** Lines run of all executable lines, over the files. */
  static total(files: FileCoverage[]): { hit: number; all: number } {
    let hit = 0;
    let all = 0;
    for (const f of files)
      for (const n of f.lines.values()) {
        all++;
        if (n > 0) hit++;
      }
    return { hit, all };
  }
}
