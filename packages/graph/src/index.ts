// SPDX-License-Identifier: BUSL-1.1
// Code graph of a rung workspace: who calls, instantiates, reads and writes what.
// Built statically from parsed sources; TIA cross-references can be merged in later.
import { STANDARD_BY_NAME, deviceOfUri, type BlockModel, type GlobalSymbol, type WorkspaceIndex } from "@rung/lsp";

export type NodeKind = "FB" | "FC" | "OB" | "DB" | "UDT" | "TAG" | "OBJECT" | "STANDARD" | "SYSTEM";
export type EdgeKind = "calls" | "instantiates" | "instanceOf" | "usesType" | "reads" | "writes";

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  uri?: string;
  /** The PLC (plc/<device>/) the object belongs to. */
  device?: string;
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

export class CodeGraph {
  readonly nodes = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();
  /** The workspace has objects of several PLCs (names are shown with their PLC then; ids always have it). */
  multiPlc = false;

  get edges(): GraphEdge[] {
    return [...this.edgeMap.values()];
  }

  /**
   * The id of `name` in the PLC `device` (none for objects outside plc/ and for standard instructions). Always
   * with the PLC, however many PLCs have objects right now: a deleted block of PLC_A is never PLC_B's.
   */
  key(name: string, device?: string): string {
    return (device ? `${device}/${name}` : name).toUpperCase();
  }

  /** How a node is named for people: with its PLC when the workspace has several. */
  label(n: GraphNode): string {
    return this.multiPlc && n.device ? `${n.device}/${n.name}` : n.name;
  }

  /** The nodes named `name`: one per PLC that has an object of that name. */
  find(name: string): GraphNode[] {
    const u = name.toUpperCase();
    return [...this.nodes.values()].filter((n) => n.name.toUpperCase() === u).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** A node id from an id (`PLC/NAME`) or a name; a name several PLCs have means the first (find() lists them). */
  private resolve(ref: string): string {
    const u = ref.toUpperCase();
    return this.nodes.has(u) ? u : (this.find(ref)[0]?.id ?? u);
  }

  private add(id: string, name: string, kind: NodeKind, uri?: string, device?: string): string {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, name, kind, ...(uri ? { uri } : {}), ...(device ? { device } : {}) });
    return id;
  }

  private edge(from: string, to: string, kind: EdgeKind, member?: string) {
    const key = `${from}|${to}|${kind}`;
    const e = this.edgeMap.get(key) ?? { from, to, kind, count: 0 };
    e.count++;
    if (member) e.members = [...new Set([...(e.members ?? []), member])].sort();
    this.edgeMap.set(key, e);
  }

  static fromIndex(index: WorkspaceIndex): CodeGraph {
    const g = new CodeGraph();
    const globals = index.allGlobals();
    g.multiPlc = new Set(globals.map((s) => deviceOfUri(s.uri)).filter(Boolean)).size > 1;
    const idOf = (s: GlobalSymbol) => g.key(s.name, deviceOfUri(s.uri));
    for (const s of globals) g.add(idOf(s), s.name, s.kind as NodeKind, s.uri, deviceOfUri(s.uri));
    const standard = (name: string) => {
      const std = STANDARD_BY_NAME.get(name.toUpperCase());
      return std ? g.add(std.name.toUpperCase(), std.name, "STANDARD") : undefined;
    };
    for (const s of globals) {
      const b = s.block;
      if (!b) continue;
      const device = deviceOfUri(s.uri);
      const from = idOf(s);
      // names in a block mean its own PLC's objects
      const lookup = (name: string): GlobalSymbol | undefined => index.global(name, s.uri);
      const unknown = (name: string) => g.add(g.key(name, device), name, "SYSTEM", undefined, device);
      const typeNode = (typeRef: string): { id: string; fb: boolean } | undefined => {
        const t = lookup(typeRef);
        if (t && (t.kind === "UDT" || t.kind === "FB")) return { id: idOf(t), fb: t.kind === "FB" };
        const std = STANDARD_BY_NAME.get(typeRef.toUpperCase());
        if (std?.kind === "functionBlock") return { id: standard(std.name)!, fb: true };
        return undefined;
      };
      if (b.kind === "DB" && b.dbOf) {
        const target = lookup(b.dbOf);
        g.edge(from, target ? idOf(target) : unknown(b.dbOf), "instanceOf");
      }
      const visitVars = (vars: BlockModel["vars"]) => {
        for (const v of vars) {
          if (v.members) visitVars(v.members);
          if (!v.typeRef) continue;
          const t = typeNode(v.typeRef);
          if (t) g.edge(from, t.id, t.fb ? "instantiates" : "usesType");
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
          if (t) g.edge(from, t.id, "calls");
          continue;
        }
        if (r.kind === "call") {
          const target = lookup(r.name);
          g.edge(from, target ? g.add(idOf(target), target.name, target.kind as NodeKind, target.uri, deviceOfUri(target.uri)) : (standard(r.name) ?? unknown(r.name)), "calls");
          continue;
        }
        // "Global"
        const target = lookup(r.name);
        if (!target) {
          g.edge(from, unknown(r.name), r.access === "call" ? "calls" : r.access === "write" ? "writes" : "reads", member);
          continue;
        }
        if (r.access === "call" && target.kind === "DB" && target.block?.dbOf) {
          // "Inst_DB"(...) calls the FB the instance DB belongs to
          const fb = lookup(target.block.dbOf);
          g.edge(from, fb ? idOf(fb) : unknown(target.block.dbOf), "calls");
          g.edge(from, idOf(target), "writes");
          continue;
        }
        g.edge(from, idOf(target), r.access === "call" ? "calls" : r.access === "write" ? "writes" : "reads", member);
      }
    }
    return g;
  }

  get(ref: string): GraphNode | undefined {
    return this.nodes.get(this.resolve(ref));
  }

  /** Edges pointing at `name` (optionally of some kinds). */
  incoming(name: string, kinds?: EdgeKind[]): GraphEdge[] {
    const id = this.resolve(name);
    return this.edges.filter((e) => e.to === id && (!kinds || kinds.includes(e.kind)));
  }

  outgoing(name: string, kinds?: EdgeKind[]): GraphEdge[] {
    const id = this.resolve(name);
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
    const start = this.resolve(name);
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
    const a = this.resolve(from);
    const b = this.resolve(to);
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
