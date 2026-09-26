// SPDX-License-Identifier: MIT
// Block headers in SCL / AWL / DB / UDT sources, and block-type sniffing for the project view.
// No vscode import: unit-tested with vitest.

export type HeaderKeyword = "FUNCTION_BLOCK" | "FUNCTION" | "ORGANIZATION_BLOCK" | "DATA_BLOCK" | "TYPE";

export interface BlockHeader {
  /** 0-based line of the header keyword. */
  line: number;
  /** Column of the keyword. */
  column: number;
  keyword: HeaderKeyword;
  name: string;
}

/** Short block type shown in the project view. */
export type BlockType = "FB" | "FC" | "OB" | "DB" | "UDT";

export const KEYWORD_TYPE: Readonly<Record<HeaderKeyword, BlockType>> = {
  FUNCTION_BLOCK: "FB",
  FUNCTION: "FC",
  ORGANIZATION_BLOCK: "OB",
  DATA_BLOCK: "DB",
  TYPE: "UDT",
};

// FUNCTION_BLOCK before FUNCTION; the name is "quoted" or a plain identifier.
export const HEADER_RE = /^(\s*)(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK|TYPE)\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i;

/**
 * Finds block headers line by line, skipping text inside (* *), /* *\/ and // comments
 * so a commented-out header does not get a CodeLens.
 */
export function findBlockHeaders(text: string): BlockHeader[] {
  const out: BlockHeader[] = [];
  const lines = text.split(/\r?\n/);
  let inComment: "(*" | "/*" | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Blank out comment text, keep columns.
    let visible = "";
    let j = 0;
    while (j < raw.length) {
      if (inComment) {
        const end = raw.indexOf(inComment === "(*" ? "*)" : "*/", j);
        if (end < 0) {
          visible += " ".repeat(raw.length - j);
          j = raw.length;
        } else {
          visible += " ".repeat(end + 2 - j);
          j = end + 2;
          inComment = null;
        }
        continue;
      }
      const two = raw.slice(j, j + 2);
      if (two === "//") {
        visible += " ".repeat(raw.length - j);
        break;
      }
      if (two === "(*" || two === "/*") {
        inComment = two;
        visible += "  ";
        j += 2;
        continue;
      }
      visible += raw[j];
      j++;
    }
    const m = HEADER_RE.exec(visible);
    if (!m) continue;
    const keyword = m[2]!.toUpperCase() as HeaderKeyword;
    out.push({ line: i, column: m[1]!.length, keyword, name: (m[3] ?? m[4])! });
  }
  return out;
}

/** The header whose block contains `line` (the last header at or above it), or the first one. */
export function headerAt(headers: readonly BlockHeader[], line: number): BlockHeader | undefined {
  let best: BlockHeader | undefined;
  for (const h of headers) if (h.line <= line) best = h;
  return best ?? headers[0];
}

/**
 * Block type from the primary file's form and the first bytes of its text.
 * Returns undefined when it cannot tell (tag tables, unknown XML, …).
 */
export function detectBlockType(form: string, head: string): BlockType | undefined {
  if (form === "db") return "DB";
  if (form === "udt") return "UDT";
  if (form === "xml") {
    const m = /SW\.(?:Blocks\.(FB|FC|OB|GlobalDB|InstanceDB|ArrayDB)|Types\.(PlcStruct))\b/.exec(head);
    if (!m) return undefined;
    if (m[2]) return "UDT";
    return m[1]!.endsWith("DB") ? "DB" : (m[1] as BlockType);
  }
  if (form === "protected.yaml") {
    const bt = /^blockType:\s*"?([A-Za-z]+)"?/m.exec(head)?.[1];
    const kind = /^kind:\s*"?([A-Za-z]+)"?/m.exec(head)?.[1];
    if (kind === "type") return "UDT";
    if (!bt) return undefined;
    if (bt === "FB" || bt === "FC" || bt === "OB") return bt;
    if (/DB$/.test(bt)) return "DB";
    return undefined;
  }
  const first = findBlockHeaders(head)[0];
  return first ? KEYWORD_TYPE[first.keyword] : undefined;
}
