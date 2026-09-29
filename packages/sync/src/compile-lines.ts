// SPDX-License-Identifier: BUSL-1.1
// Maps TIA compiler positions to lines of the workspace file.
// Fact F7: V20 reports body messages with the line number counted from the line
// after BEGIN, and declaration messages with the path "Interface". The workspace file is TIA's own source
// export, so BEGIN is the same line TIA counts from.

export interface CompilePosition {
  description: string;
  line?: number;
  bodyLine?: number;
  section?: string;
}

// words in compiler messages that never name a declaration
const STOP = new Set(["data", "type", "types", "tag", "tags", "the", "not", "defined", "unknown", "invalid", "block", "value", "is", "of", "for", "and", "with", "cannot", "be", "used"]);

/** 1-based file line of a compiler message, or undefined when it cannot be placed. */
export function fileLineOf(text: string, m: CompilePosition): number | undefined {
  if (m.line) return m.line;
  const lines = text.split(/\r?\n/);
  const begin = beginLine(lines);
  if (m.section === "body" && m.bodyLine) {
    if (begin === undefined) return undefined;
    const line = begin + 1 + m.bodyLine; // begin is 0-based, the result 1-based
    return line <= lines.length ? line : undefined;
  }
  if (m.section === "interface") {
    const end = begin ?? lines.length;
    const words = (m.description.match(/[#"]?[\p{L}_][\p{L}\p{N}_]*/gu) ?? [])
      .map((w) => w.replace(/^[#"]/, ""))
      .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
    for (const w of words) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}_]|$)`, "iu");
      for (let i = 0; i < end; i++) if (re.test(stripComment(lines[i]!))) return i + 1;
    }
    for (let i = 0; i < end; i++) if (/^\s*VAR(_\w+)?\b/i.test(lines[i]!)) return i + 1;
  }
  return undefined;
}

/** 0-based index of the BEGIN line, skipping comments and strings. */
function beginLine(lines: string[]): number | undefined {
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]!;
    if (inBlock) {
      const e = l.indexOf("*)");
      if (e < 0) continue;
      l = l.slice(e + 2);
      inBlock = false;
    }
    l = l.replace(/\(\*[\s\S]*?\*\)/g, " ");
    const open = l.indexOf("(*");
    if (open >= 0) {
      inBlock = true;
      l = l.slice(0, open);
    }
    if (/^\s*BEGIN\s*$/i.test(stripComment(l))) return i;
  }
  return undefined;
}

function stripComment(l: string): string {
  return l.replace(/'(?:[^'$]|\$.)*'/g, "''").replace(/\/\/.*$/, "");
}

export interface PlacedMessage extends CompilePosition {
  address?: string;
  severity: string;
  path?: string;
  /** workspace file of the object, when rung mirrors it */
  file?: string;
  column?: number;
}

/** Adds the workspace file and file line to compiler messages; unreadable files just stay unplaced. */
export async function placeCompileMessages<T extends PlacedMessage>(root: string, fileOf: (address: string) => string | undefined, msgs: T[], read: (path: string) => Promise<string>): Promise<T[]> {
  const cache = new Map<string, string | null>();
  const out: T[] = [];
  for (const m of msgs) {
    const file = m.address ? fileOf(m.address) : undefined;
    if (!file) {
      out.push(m);
      continue;
    }
    if (!cache.has(file)) cache.set(file, await read(`${root}/${file}`).catch(() => null));
    const text = cache.get(file);
    const line = text == null ? undefined : fileLineOf(text, m);
    out.push({ ...m, file, ...(line ? { line } : {}) });
  }
  return out;
}
