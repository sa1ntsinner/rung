// SPDX-License-Identifier: MIT
// The Usages tree's nodes from the language server's answer (rung/usages): writers first, then readers and the calls
// that hand the value on, each with where it is called from; last, a line on what static analysis cannot see.

interface Pos {
  line: number;
  character: number;
}
export interface PlainRange {
  start: Pos;
  end: Pos;
}

/** One use as the language server reports it (rung/usages). */
export interface Site {
  uri: string;
  range: PlainRange;
  kind: "read" | "write";
  block?: string;
  text: string;
  calledFrom?: { block: string; uri: string; range: PlainRange }[];
  through?: { block: string; param: string; uri: string; range: PlainRange; text: string };
  whole?: boolean;
  handedTo?: { block: string; param: string };
}

export interface Usages {
  writes: Site[];
  reads: Site[];
  handedOn?: Site[];
}

export interface UNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** a codicon name */
  icon?: string;
  /** where a click goes */
  location?: { uri: string; range: PlainRange };
  children?: UNode[];
}

const NOT_SEEN = "HMI, communication blocks and indirect access (pointers, VARIANT, PEEK/POKE) are not seen.";

export function usagesTree(r: Usages, rel: (uri: string) => string): UNode[] {
  const at = (uri: string, range: PlainRange) => `${rel(uri)}:${range.start.line + 1}`;
  const siteNode = (s: Site, group: string, n: number): UNode => {
    const children: UNode[] = [];
    if (s.through) children.push({ id: `${group}-${n}-through`, label: `as ${s.through.param}, from ${s.through.block}`, description: at(s.through.uri, s.through.range), tooltip: s.through.text, icon: "arrow-small-right", location: { uri: s.through.uri, range: s.through.range } });
    for (const [i, c] of (s.calledFrom ?? []).entries()) children.push({ id: `${group}-${n}-call-${i}`, label: `called from ${c.block}`, description: at(c.uri, c.range), icon: "call-incoming", location: { uri: c.uri, range: c.range } });
    if (s.handedTo) children.push({ id: `${group}-${n}-handed`, label: `to ${s.handedTo.block} as ${s.handedTo.param}`, icon: "arrow-small-right" });
    return {
      id: `${group}-${n}`,
      label: s.block ?? rel(s.uri),
      description: `${at(s.uri, s.range)} · ${s.text}`,
      tooltip: `${s.text}${s.whole ? "\n(the whole structure)" : ""}`,
      icon: group === "writes" ? "edit" : group === "reads" ? "eye" : "arrow-right",
      location: { uri: s.uri, range: s.range },
      ...(children.length ? { children } : {}),
    };
  };
  const group = (key: string, label: string, sites: Site[] | undefined): UNode[] =>
    sites?.length ? [{ id: key, label, description: String(sites.length), children: sites.map((s, i) => siteNode(s, key, i)) }] : [];
  const groups = [...group("writes", "Writes", r.writes), ...group("reads", "Reads", r.reads), ...group("handed", "Handed on", r.handedOn)];
  return [...(groups.length ? groups : [{ id: "none", label: "No uses in the workspace", icon: "info" }]), { id: "coverage", label: "Workspace code only", tooltip: NOT_SEEN, icon: "info" }];
}

/** A question asked of the Usages view, newest first: the same name in the same file once, at most `max`. */
export function remember<Q extends { symbol: string; uri: string }>(history: Q[], q: Q, max = 10): Q[] {
  return [q, ...history.filter((h) => h.symbol !== q.symbol || h.uri !== q.uri)].slice(0, max);
}
