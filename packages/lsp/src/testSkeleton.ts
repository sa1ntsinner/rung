// SPDX-License-Identifier: BUSL-1.1
// The first test of a block (rung/testSkeleton): its inputs set to their start values, one cycle, its outputs to
// expect, written in the form docs/testing.md shows. The engineer changes the expected values; nothing is guessed.
import { escapeSegment } from "@rung/core";
import type { DeclModel, DeclRow } from "./declarations.js";

const INTEGER = /^(S|U|US|D|UD|L|UL)?INT$|^(BYTE|WORD|DWORD|LWORD)$/i;
const REAL = /^L?REAL$/i;
const TIME = /^L?TIME$/i;

/** A YAML value for a type's default or a source start value; undefined for a type a test sets member by member. */
/** A whole number literal's value: 7, INT#7, 16#FF, DINT#-5, 2#1010 (undefined for anything else). */
function integer(literal: string): string | undefined {
  const m = /^(?:[A-Z]+#)?([-+]?)(?:(2|8|16)#)?([0-9A-F_]+)$/i.exec(literal);
  if (!m) return undefined;
  const n = parseInt(m[3]!.replace(/_/g, ""), m[2] ? Number(m[2]) : 10);
  return Number.isFinite(n) ? String(m[1] === "-" ? -n : n) : undefined;
}

function value(row: DeclRow): string | undefined {
  const t = row.type.trim();
  const start = row.start?.trim().replace(/^BOOL#/i, "");
  if (/^BOOL$/i.test(t)) return start ? String(/^(TRUE|1)$/i.test(start)) : "false";
  if (INTEGER.test(t)) return (start && integer(start)) ?? "0";
  // a string or a character: SCL's '…' with '' inside is also YAML's single-quoted text
  if (/^W?(STRING|CHAR)\b/i.test(t)) return start && /^'(?:[^']|'')*'$/.test(start) ? start : "''";
  if (REAL.test(t)) return start && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(start) ? start : "0.0";
  if (TIME.test(t)) return start && /^L?T#[\w.]+$/i.test(start) ? start : "T#0ms";
  return undefined;
}

/** A key as YAML reads it: a plain name, else single-quoted. */
const key = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

const flow = (pairs: [string, string][]) => `{ ${pairs.map(([k, v]) => `${key(k)}: ${v}`).join(", ")} }`;

export function testSkeleton(model: DeclModel, where: { plc?: string; severalPlcs: boolean }): { path: string; text: string } {
  const block = model.block?.name ?? "Block";
  const rows = (title: string) => model.sections.filter((s) => s.title === title).flatMap((s) => s.rows);
  const pairs = (list: DeclRow[]) => list.flatMap((r): [string, string][] => {
    const v = value(r);
    return v === undefined ? [] : [[r.name, v]];
  });
  const set = pairs([...rows("Input"), ...rows("InOut")]);
  const out = pairs([...rows("Output"), ...rows("InOut")]);
  // an FC's return value is expected under the block's own name
  const ret = model.block?.returnType;
  if (model.block?.kind === "FC" && ret && !/^void$/i.test(ret)) {
    const v = value({ type: ret } as DeclRow);
    if (v !== undefined) out.unshift([block, v]);
  }
  const lines = [`block: ${key(block)}`, "cases:", "  - name: first case", "    steps:"];
  if (set.length) lines.push(`      - set: ${flow(set)}`);
  lines.push("      - cycle: 1");
  if (out.length) lines.push(`      # what ${block} should give: change these values`, `      - expect: ${flow(out)}`);
  // a file name the workspace can hold whatever the block is called ("Fx/Motor", "CON")
  const folder = where.severalPlcs && where.plc ? `${escapeSegment(where.plc)}/` : "";
  return { path: `tests/${folder}${escapeSegment(block)}.test.yaml`, text: lines.join("\n") + "\n" };
}
