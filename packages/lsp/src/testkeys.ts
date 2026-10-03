// SPDX-License-Identifier: BUSL-1.1
// A block's parameter renamed in the editor is renamed in its YAML tests too: the keys of set: and expect: that
// name it (Start, "Data.Running"), in the test files whose block: is that block. Stubs of other blocks are left alone.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface KeyEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The edits per test file (absolute path) that rename `name` to `newName` as a key of the tests of `block`. */
export async function testKeyEdits(root: string, block: string, name: string, newName: string): Promise<Map<string, KeyEdit[]>> {
  const out = new Map<string, KeyEdit[]>();
  const files = await readdir(join(root, "tests"), { recursive: true }).catch(() => [] as string[]);
  const ofBlock = new RegExp(`^block:\\s*["']?${escape(block)}["']?\\s*(#.*)?$`, "im");
  // a key: after {, a comma or the indent, quoted or not, the name alone or the first part of a dotted path
  const key = new RegExp(`(?<=(?:^|[{,])\\s*["']?)${escape(name)}(?=(?:\\.[^"':,{}\\s]+)*["']?\\s*:)`, "gi");
  for (const f of files.map(String).filter((f) => /\.test\.ya?ml$/i.test(f))) {
    const path = join(root, "tests", f);
    const text = await readFile(path, "utf8").catch(() => "");
    if (!ofBlock.test(text)) continue;
    const edits: KeyEdit[] = [];
    // inside a set: or expect: map (on its line, or on the lines indented below it)
    let under = -1;
    text.split(/\r?\n/).forEach((line, n) => {
      const indent = line.search(/\S/);
      const opens = /(^|\s|-)(set|expect):/.exec(line);
      if (opens) under = indent;
      else if (indent >= 0 && indent <= under) under = -1;
      if (!opens && under < 0) return;
      const from = opens ? opens.index + opens[0].length : 0;
      for (const m of line.slice(from).matchAll(key)) {
        const at = from + m.index!;
        edits.push({ range: { start: { line: n, character: at }, end: { line: n, character: at + name.length } }, newText: newName });
      }
    });
    if (edits.length) out.set(path, edits);
  }
  return out;
}
