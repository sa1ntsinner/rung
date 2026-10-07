// SPDX-License-Identifier: MIT
// A .conflict file (rung's diff3 markers: <<<<<<< file, ||||||| base, =======, >>>>>>> tia) as the three versions
// VS Code's merge editor shows: the common ancestor, your file and TIA Portal's version.

const OPEN = /^<<<<<<< file\s*$/;
const BASE = /^\|\|\|\|\|\|\| base\s*$/;
const MID = /^=======\s*$/;
const CLOSE = /^>>>>>>> tia\s*$/;

export const hasMarkers = (text: string) => /^<<<<<<< file\s*$/m.test(text);

/** The three versions, or undefined when there are no markers or they do not close. */
export function splitConflict(text: string): { base: string; file: string; tia: string } | undefined {
  if (!hasMarkers(text)) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out = { base: [] as string[], file: [] as string[], tia: [] as string[] };
  let part: "common" | "file" | "base" | "tia" = "common";
  for (const l of lines) {
    if (part === "common" && OPEN.test(l)) part = "file";
    else if (part === "file" && BASE.test(l)) part = "base";
    else if ((part === "file" || part === "base") && MID.test(l)) part = "tia";
    else if (part === "tia" && CLOSE.test(l)) part = "common";
    else if (part === "common") {
      out.base.push(l);
      out.file.push(l);
      out.tia.push(l);
    } else out[part].push(l);
  }
  if (part !== "common") return undefined;
  return { base: out.base.join(eol), file: out.file.join(eol), tia: out.tia.join(eol) };
}
