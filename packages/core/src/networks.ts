// SPDX-License-Identifier: BUSL-1.1
// The networks of a LAD/FBD block in the two text forms rung mirrors it in: SimaticML XML (one SW.Blocks.CompileUnit
// per network; TIA Portal V20 keeps a block with network titles or comments only there) and SIMATIC SD (NETWORK …
// END_NETWORK, the language line above it). A block is its head, its networks and its tail, for merging and
// reviewing network by network.

export type NetworkForm = "xml" | "s7dcl";

export interface NetworkSplit {
  /** Everything before the first network: interface, attributes, the block's comment. */
  head: string;
  /** Each network with the blank lines after it, as written. */
  networks: string[];
  /** Everything after the last network. */
  tail: string;
}

const UNIT: Record<NetworkForm, RegExp> = {
  xml: /^[ \t]*<SW\.Blocks\.CompileUnit\b[\s\S]*?^[ \t]*<\/SW\.Blocks\.CompileUnit>[^\n]*(?:\n|$)/gm,
  s7dcl: /^(?:[ \t]*\{[^{}]*\}[ \t]*\n)?[ \t]*NETWORK\b[\s\S]*?^[ \t]*END_NETWORK\b[^\n]*(?:\n|$)/gm,
};

/**
 * The block's head, networks and tail, or undefined when the text is not a block with networks rung can take
 * apart (a watch table, anything between two networks that is not blank).
 */
export function splitNetworks(text: string, form: NetworkForm): NetworkSplit | undefined {
  if (form === "xml" && !/<SW\.Blocks\.(FB|FC|OB)\b/.test(text)) return undefined;
  if (form === "s7dcl" && !/^[ \t]*(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/m.test(text)) return undefined;
  const found = [...text.matchAll(UNIT[form])].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const networks: string[] = [];
  for (const [i, u] of found.entries()) {
    const next = found[i + 1]?.start;
    if (next !== undefined && text.slice(u.end, next).trim()) return undefined; // something else between networks
    networks.push(text.slice(u.start, next ?? u.end));
  }
  if (!found.length) return { head: text, networks: [], tail: "" };
  return { head: text.slice(0, found[0]!.start), networks, tail: text.slice(found.at(-1)!.end) };
}

/** A network as compared: without layout at its end and, in XML, without the object IDs TIA Portal renumbers. */
export function networkKey(unit: string, form: NetworkForm): string {
  const t = unit.replace(/\s+$/, "");
  return form === "xml" ? blankIds(t) : t;
}

/** SimaticML object IDs (ID="3", not UId) as ID="*": one inserted network renumbers every object after it. */
export function blankIds(xml: string): string {
  return xml.replace(/(\sID=")[^"]*(")/g, "$1*$2");
}

/** Fresh object IDs in document order (0, 1, … 9, A, B, …), as TIA Portal numbers them. */
export function renumberIds(xml: string): string {
  let n = 0;
  return xml.replace(/(\sID=")[^"]*(")/g, (_, a: string, b: string) => `${a}${(n++).toString(16).toUpperCase()}${b}`);
}
