// SPDX-License-Identifier: BUSL-1.1
// Code graph of a rung workspace: who calls, instantiates, reads and writes what.
// Built statically from parsed sources; TIA cross-references can be merged in later.
import { STANDARD_BY_NAME, type BlockModel, type GlobalSymbol, type WorkspaceIndex } from "@rung/lsp";

export type NodeKind = "FB" | "FC" | "OB" | "DB" | "UDT" | "TAG" | "OBJECT" | "STANDARD" | "SYSTEM";
export type EdgeKind = "calls" | "instantiates" | "instanceOf" | "usesType" | "reads" | "writes";

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  uri?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Occurrences in source (a block may read a DB many times). */
  count: number;
  /** Members touched for reads/writes, e.g. ["Counter", "Station.Setpoint"]. */
  members?: string[];
}

export interface ImpactEntry {
  node: GraphNode;
  distance: number;
  via: EdgeKind;
}

const idOf = (name: string) => name.toUpperCase();

export class CodeGraph {
  readonly nodes = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();

  get edges(): GraphEdge[] {
    return [...this.edgeMap.values()];
  }

  private node(name: string, kind: NodeKind, uri?: string): GraphNode {
    const id = idOf(name);
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, name, kind, ...(uri ? { uri } : {}) };
      this.nodes.set(id, n);
    }
    return n;
  }

  private edge(from: string, to: string, kind: EdgeKind, member?: string) {
    const key = `${idOf(from)}|${idOf(to)}|${kind}`;
    const e = this.edgeMap.get(key) ?? { from: idOf(from), to: idOf(to), kind, count: 0 };
    e.count++;
    if (member) e.members = [...new Set([...(e.members ?? []), member])].sort();
    this.edgeMap.set(key, e);
  }

  static fromIndex(index: WorkspaceIndex): CodeGraph {
    const g = new CodeGraph();
    const globals = index.allGlobals();
    for (const s of globals) g.node(s.name, s.kind as NodeKind, s.uri);
    const lookup = (name: string): GlobalSymbol | undefined => index.global(name);
    const typeNode = (typeRef: string): string | undefined => {
      const s = lookup(typeRef);
      if (s && (s.kind === "UDT" || s.kind === "FB")) return s.name;
      const std = STANDARD_BY_NAME.get(typeRef.toUpperCase());
      if (std?.kind === "functionBlock") return g.node(std.name, "STANDARD").name;
      return undefined;
    };
    for (const s of globals) {
      const b = s.block;
      if (!b) continue;
      if (b.kind === "DB" && b.dbOf) {
        const target = lookup(b.dbOf);
        g.edge(b.name, target?.name ?? b.dbOf, "instanceOf");
        if (!target) g.node(b.dbOf, "SYSTEM");
      }
      const visitVars = (vars: BlockModel["vars"]) => {
        for (const v of vars) {
          if (v.members) visitVars(v.members);
          if (!v.typeRef) continue;
          const t = typeNode(v.typeRef);
          if (!t) continue;
          const kind = lookup(t)?.kind === "FB" || STANDARD_BY_NAME.get(t.toUpperCase())?.kind === "functionBlock" ? "instantiates" : "usesType";
          g.edge(b.name, t, kind);
        }
      };
      visitVars(b.vars);
      for (const r of b.refs) {
        const member = r.members.map((m) => m.name).join(".") || undefined;
        if (r.kind === "local") {
          if (r.access !== "call") continue;
          // #instance(...) calls the FB type of the local variable
          const decl = b.vars.find((v) => v.name.toUpperCase() === r.name.toUpperCase());
          const t = decl?.typeRef && typeNode(decl.typeRef);
          if (t) g.edge(b.name, t, "calls");
          continue;
        }
        if (r.kind === "call") {
          const std = STANDARD_BY_NAME.get(r.name.toUpperCase());
          const target = lookup(r.name);
          g.node(target?.name ?? std?.name ?? r.name, target ? (target.kind as NodeKind) : std ? "STANDARD" : "SYSTEM");
          g.edge(b.name, target?.name ?? std?.name ?? r.name, "calls");
          continue;
        }
        // "Global"
        const target = lookup(r.name);
        if (!target) {
          g.node(r.name, "SYSTEM");
          g.edge(b.name, r.name, r.access === "call" ? "calls" : r.access === "write" ? "writes" : "reads", member);
          continue;
        }
        if (r.access === "call") {
          if (target.kind === "DB" && target.block?.dbOf) {
            // "Inst_DB"(...) calls the FB the instance DB belongs to
            g.edge(b.name, lookup(target.block.dbOf)?.name ?? target.block.dbOf, "calls");
            g.edge(b.name, target.name, "writes");
          } else g.edge(b.name, target.name, "calls");
          continue;
        }
        g.edge(b.name, target.name, r.access === "write" ? "writes" : "reads", member);
      }
    }
    return g;
  }

  get(name: string): GraphNode | undefined {
    return this.nodes.get(idOf(name));
  }

  /** Edges pointing at `name` (optionally of some kinds). */
  incoming(name: string, kinds?: EdgeKind[]): GraphEdge[] {
    const id = idOf(name);
    return this.edges.filter((e) => e.to === id && (!kinds || kinds.includes(e.kind)));
  }

  outgoing(name: string, kinds?: EdgeKind[]): GraphEdge[] {
    const id = idOf(name);
    return this.edges.filter((e) => e.from === id && (!kinds || kinds.includes(e.kind)));
  }

  callers(name: string): GraphNode[] {
    return this.incoming(name, ["calls"]).map((e) => this.nodes.get(e.from)!);
  }

  callees(name: string): GraphNode[] {
    return this.outgoing(name, ["calls"]).map((e) => this.nodes.get(e.to)!);
  }

  /** Every object that touches `name` in any way, with how. */
  usages(name: string): { node: GraphNode; kind: EdgeKind; count: number; members?: string[] }[] {
    return this.incoming(name).map((e) => ({ node: this.nodes.get(e.from)!, kind: e.kind, count: e.count, ...(e.members ? { members: e.members } : {}) }));
  }

  /** Transitive dependants: what may break or behave differently if `name` changes. */
  impact(name: string, maxDepth = 10): ImpactEntry[] {
    const start = idOf(name);
    const seen = new Map<string, ImpactEntry>();
    let frontier = [start];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const e of this.edges)
          if (e.to === id && e.from !== start && !seen.has(e.from)) {
            seen.set(e.from, { node: this.nodes.get(e.from)!, distance: d, via: e.kind });
            next.push(e.from);
          }
      frontier = next;
    }
    return [...seen.values()].sort((a, b) => a.distance - b.distance || a.node.name.localeCompare(b.node.name));
  }

  /** Shortest dependency path from `from` to `to` following outgoing edges. */
  path(from: string, to: string): GraphNode[] | null {
    const a = idOf(from);
    const b = idOf(to);
    const prev = new Map<string, string | null>([[a, null]]);
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === b) {
        const out: GraphNode[] = [];
        for (let x: string | null = b; x; x = prev.get(x) ?? null) out.unshift(this.nodes.get(x)!);
        return out;
      }
      for (const e of this.edges) if (e.from === cur && !prev.has(e.to)) {
        prev.set(e.to, cur);
        queue.push(e.to);
      }
    }
    return null;
  }

  toJSON() {
    return { nodes: [...this.nodes.values()].sort((x, y) => x.id.localeCompare(y.id)), edges: this.edges.sort((x, y) => (x.from + x.to + x.kind).localeCompare(y.from + y.to + y.kind)) };
  }
}
