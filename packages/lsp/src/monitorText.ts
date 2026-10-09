// SPDX-License-Identifier: BUSL-1.1
// Copied from editors/vscode/src/core/monitorText.ts, under the MIT license below.
/*
MIT License

Copyright (c) 2026 Elmir Mirzayev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

*/
/** How a value reads at the end of a line: TRUE/FALSE like TIA Portal, reals shortened, strings quoted. */
export function formatValue(v: unknown): string {
  if (v === undefined) return "…";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  if (typeof v === "string") return `'${v}'`;
  return JSON.stringify(v);
}

/** The text after a line: `Lit = TRUE   On = TRUE`; a value that could not be read shows as ?. */
export function lineText(labels: readonly string[], values: Record<string, unknown>, errors: Record<string, string>, display?: Record<string, string>): string {
  return labels.map((l) => `${l.replace(/^#/, "")} = ${l in errors ? "?" : display?.[l] ?? formatValue(values[l])}`).join("   ");
}
