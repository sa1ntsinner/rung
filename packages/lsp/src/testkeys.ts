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

/**
 * The edits per test file (absolute path) that rename `name` to `newName` as a key of the tests of `block`; with
 * `device`, a file that names another PLC (`plc: PLC_2`) tests another block of that name and is left alone.
 */
export async function testKeyEdits(root: string, block: string, name: string, newName: string, device?: string): Promise<Map<string, KeyEdit[]>> {
  const out = new Map<string, KeyEdit[]>();
  const files = await readdir(join(root, "tests"), { recursive: true }).catch(() => [] as string[]);
  const ofBlock = new RegExp(`^block:\\s*["']?${escape(block)}["']?\\s*(#.*)?$`, "im");
  // a key: after {, a comma or the indent, quoted or not, the name alone or the first part of a path (the rest:
  // .x members and [2] elements, "Points[2].x")
  const key = new RegExp(`(?<=(?:^|[{,])\\s*["']?)${escape(name)}(?=((?:\\[[^\\]]*\\]|\\.[^"':,{}\\s\\[]+)*)["']?\\s*:)`, "gi");
  // a name YAML takes unquoted as a key; "Reset: Manual" needs quotes
  const plain = /^[A-Za-z_]\w*$/.test(newName);
  for (const f of files.map(String).filter((f) => /\.test\.ya?ml$/i.test(f))) {
    const path = join(root, "tests", f);
    const text = await readFile(path, "utf8").catch(() => "");
    if (!ofBlock.test(text)) continue;
    const plc = /^plc:\s*["']?([^"'#\n]*?)["']?\s*(#.*)?$/im.exec(text)?.[1]?.trim();
    if (device && plc && plc.toUpperCase() !== device.toUpperCase()) continue;
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
      // what is inside a quoted value ('operator, Start: true') is no key; a quoted key ("Start": true) is
      const visible = line.slice(from).replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, (q: string, at: number, s: string) => (/^\s*:/.test(s.slice(at + q.length)) ? q : " ".repeat(q.length)));
      const edit = (at: number, length: number, newText: string) => edits.push({ range: { start: { line: n, character: at }, end: { line: n, character: at + length } }, newText });
      for (const m of visible.matchAll(key)) {
        const at = from + m.index!;
        const quote = line[at - 1];
        if (quote === '"') edit(at, name.length, JSON.stringify(newName).slice(1, -1));
        else if (quote === "'") edit(at, name.length, newName.replace(/'/g, "''"));
        // unquoted, a name YAML takes only quoted: the whole key quoted, with the rest of its path
        else if (!plain) edit(at, name.length + (m[1] ?? "").length, JSON.stringify(newName + (m[1] ?? "")));
        else edit(at, name.length, newName);
      }
    });
    if (edits.length) out.set(path, edits);
  }
  return out;
}

/** The test files (relative to `root`, with /) whose block: is `block`, leaving out those of another PLC. */
export async function testFilesOf(root: string, block: string, device?: string): Promise<string[]> {
  const files = await readdir(join(root, "tests"), { recursive: true }).catch(() => [] as string[]);
  const ofBlock = new RegExp(`^block:\\s*["']?${escape(block)}["']?\\s*(#.*)?$`, "im");
  const plcs = new Set((await readdir(join(root, "plc")).catch(() => [] as string[])).map((p) => String(p).toUpperCase()));
  const out: string[] = [];
  for (const f of files.map(String).filter((f) => /\.test\.ya?ml$/i.test(f))) {
    const text = await readFile(join(root, "tests", f), "utf8").catch(() => "");
    if (!ofBlock.test(text)) continue;
    const plc = /^plc:\s*["']?([^"'#\n]*?)["']?\s*(#.*)?$/im.exec(text)?.[1]?.trim();
    if (device && plc && plc.toUpperCase() !== device.toUpperCase()) continue;
    // no plc: in the file, kept under tests/<PLC>/: that PLC's, as rung test reads it
    const folder = f.split(/[\\/]/).length > 1 ? f.split(/[\\/]/)[0]! : undefined;
    if (device && !plc && folder && plcs.has(folder.toUpperCase()) && folder.toUpperCase() !== device.toUpperCase()) continue;
    out.push(`tests/${f.split("\\").join("/")}`);
  }
  return out;
}
