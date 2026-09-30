// SPDX-License-Identifier: BUSL-1.1
// rung mcp: a small, agent-native tool surface. Agents read and edit the mirrored files directly;
// the tools cover what files cannot tell: sync, compile, diagnostics, graph, conflicts and safety.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffIndices } from "node-diff3";
import { BlobStore, loadConfig, normalizeText, parseAddress, realProbes, runChecks, StateStore, type ObjectState } from "@rung/core";
import { OwnerClient, confirmDelete, placeCompileMessages, renameObject, resolveConflict, syncOnce, type Diagnostic, type RenameReport, type SyncBridge, type SyncReport } from "@rung/sync";
import { WorkspaceIndex, assignmentList, nearest, diagnostics as parseDiagnostics, uriOf } from "@rung/lsp";
import { CodeGraph } from "@rung/graph";
import { WebApiClient, plainHttpRefusal } from "@rung/live";
import { runTests } from "@rung/sim";
import type { CompareOutcome, ConnectionTarget } from "@rung/bridge-client";
import { handover } from "./handover.js";

export interface McpContext {
  root: string;
  /** Environment for secrets such as RUNG_WEBAPI_PASSWORD (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Starts a bridge for one-off operations when no `rung watch` owner is running. */
  bridgeFactory?: () => Promise<
    SyncBridge & { close(): Promise<void>; deleteObject?(a: string, e: string, o: string): Promise<unknown>; compare?(device: string, target?: ConnectionTarget): Promise<CompareOutcome> }
  >;
  /** Whether the bridge is in the Openness whitelist (the CLI knows where the bridge is). */
  bridgeWhitelisted?: () => Promise<"ok" | "missing" | "stale" | "unknown">;
}

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): Text => text(JSON.stringify(v, null, 2));
const fail = (t: string): Text => ({ content: [{ type: "text", text: t }], isError: true });

export const SAFETY_RULES = `rung safety rules for agents
1. Edit the mirrored files under plc/ directly; changes reach TIA Portal through rung sync / rung watch.
2. Never edit read-only objects: *.protected.yaml (know-how protected), failsafe (F_*) blocks, system blocks, GRAPH blocks. rung refuses to import them.
3. Never download to a PLC, never run rung download or change a PLC's operating mode. Prepare the download with rung_download_request; the person downloads after reviewing the change (rung download asks them to type the PLC name).
4. Resolve conflicts only with rung_resolve (keep the file, take TIA's version, or save a merged file first).
5. Run rung_find_usages before changing an interface (VAR_INPUT/OUTPUT/IN_OUT, UDT members, DB layout): every caller and instance DB is affected.
6. After a sync, read rung_diagnostics; compile errors come from TIA Portal itself.`;

/** state.json read without taking the writer lock (safe while rung watch runs). */
async function stateSnapshot(root: string): Promise<ObjectState[]> {
  try {
    const doc = JSON.parse(await readFile(join(root, ".rung", "state.json"), "utf8")) as { objects: Record<string, ObjectState> };
    return Object.values(doc.objects);
  } catch {
    return [];
  }
}

async function syncDiagnostics(root: string): Promise<Diagnostic[]> {
  try {
    return (JSON.parse(await readFile(join(root, ".rung", "diagnostics.json"), "utf8")) as { items: Diagnostic[] }).items ?? [];
  } catch {
    return [];
  }
}

function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const la = a.split("\n");
  const lb = b.split("\n");
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const h of diffIndices(la, lb)) {
    const [aStart, aLen] = h.buffer1;
    const [bStart, bLen] = h.buffer2;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const l of la.slice(aStart, aStart + aLen)) out.push("-" + l);
    for (const l of lb.slice(bStart, bStart + bLen)) out.push("+" + l);
  }
  return out.length > 2 ? out.join("\n") : "(no changes)";
}

/** The PLC a command means when none is named: the only one rung mirrors, or undefined when there are several. */
async function onlyDevice(bridge: { projectInfo(): Promise<{ devices: string[] }> }, configured: string[]): Promise<string | undefined> {
  const devices = configured.length ? configured : (await bridge.projectInfo()).devices;
  return devices.length === 1 ? devices[0] : undefined;
}

/** Statuses of a mirrored object (ObjectState.status) an agent can filter by. */
const STATUSES = ["synced", "conflicted", "fileDirty", "pendingDelete", "recoveryRequired", "importing"] as const;

/** A path as an agent writes it (backslashes, absolute, ./) in the workspace's form: plc/PLC_1/blocks/X.scl. */
function workspacePath(root: string, p: string): string {
  return (isAbsolute(p) ? relative(root, p) : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The path (or address) an agent most likely meant: a typo in the file name, or the file in another folder; of
 * several files of that name, the one that shares most of the given path (its PLC, its folders).
 */
function nearestPath(given: string, candidates: readonly string[]): string | undefined {
  const leaf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const name = nearest(leaf(given), new Set(candidates.map(leaf)));
  if (name === undefined) return undefined;
  const shared = (c: string) => {
    let i = 0;
    while (i < c.length && i < given.length && c[i]!.toLowerCase() === given[i]!.toLowerCase()) i++;
    return i;
  };
  return candidates.filter((c) => leaf(c) === name).sort((a, b) => shared(b) - shared(a))[0];
}

/** ": did you mean X?" when something is close. */
const meant = (near: string | undefined) => (near ? `: did you mean ${near}?` : "");

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "rung", version: "0.1.0" }, { instructions: SAFETY_RULES });
  let cache: { at: number; index: WorkspaceIndex; graph: CodeGraph } | undefined;
  const model = async () => {
    if (!cache || Date.now() - cache.at > 2000) {
      const index = new WorkspaceIndex();
      await index.load(ctx.root);
      cache = { at: Date.now(), index, graph: CodeGraph.fromIndex(index) };
    }
    return cache;
  };
  const withOwner = async <T>(fn: (o: OwnerClient) => Promise<T>): Promise<T | undefined> => {
    const o = await OwnerClient.connect(ctx.root);
    if (!o) return undefined;
    try {
      return await fn(o);
    } finally {
      o.close();
    }
  };
  /** Tools that sync, compile or change a workspace need one: the answer says how a person makes it. */
  const noWorkspace = (): Text | undefined =>
    existsSync(join(ctx.root, "rung.toml")) ? undefined : fail(`${ctx.root} is not a rung workspace (no rung.toml). A person binds a folder to a project with rung init --project <path to the .ap20 or .project>, then rung pull.`);
  /** The mirrored object an address or a workspace path names. */
  const objectOf = async (addressOrPath: string) => {
    const p = workspacePath(ctx.root, addressOrPath);
    return (await stateSnapshot(ctx.root)).find((s) => s.address === addressOrPath || s.path === p);
  };
  /** The workspace path of a file of the index (plc/PLC_1/tags/Default tag table.tags.st, not %20). */
  const pathOf = (uri: string) => relative(ctx.root, fileURLToPath(uri)).split(sep).join("/");
  /** ": did you mean X?" for an address or path that names no mirrored object (of those `which` keeps). */
  const meantObject = async (given: string, which: (s: ObjectState) => boolean = () => true) => {
    const states = (await stateSnapshot(ctx.root)).filter(which);
    return meant(nearestPath(given.startsWith("plc:") ? given : workspacePath(ctx.root, given), states.map((s) => (given.startsWith("plc:") ? s.address : s.path))));
  };
  /** ": did you mean X?" for an object name (Fx_Motor, PLC_1/Fx_Motor), address or path the workspace does not have. */
  const meantName = async (index: WorkspaceIndex, name: string) => {
    const bare = name.replace(/^"|"$/g, "");
    if (/^plc[:/]/.test(bare) || bare.includes("\\")) return meantObject(bare);
    const slash = bare.lastIndexOf("/");
    const near = nearest(bare.slice(slash + 1), new Set(index.allGlobals().map((s) => s.name)));
    return meant(near === undefined ? undefined : bare.slice(0, slash + 1) + near);
  };
  /**
   * The PLC a tool means when none is named, as the CLI chooses it: the one rung.toml names, the one mirrored, or
   * the project's only PLC. A message instead when it has to be named.
   */
  const chooseDevice = async (given: string | undefined, info?: () => Promise<{ devices: string[] }>): Promise<{ device: string } | { problem: string }> => {
    if (given) return { device: given };
    const config = await loadConfig(ctx.root);
    if (config.devices.length === 1) return { device: config.devices[0]! };
    if (Object.keys(config.plc).length === 1) return { device: Object.keys(config.plc)[0]! };
    const mirrored = [...new Set((await stateSnapshot(ctx.root)).map((s) => parseAddress(s.address).device))].sort();
    if (mirrored.length === 1) return { device: mirrored[0]! };
    if (mirrored.length) return { problem: `This workspace mirrors several PLCs (${mirrored.join(", ")}); pass device.` };
    if (!info) return { problem: "Nothing is mirrored yet, so rung cannot tell which PLC; pass device." };
    const devices = (await info()).devices;
    if (devices.length === 1) return { device: devices[0]! };
    return { problem: devices.length ? `The project has several PLCs (${devices.join(", ")}); pass device.` : "The project has no PLC." };
  };
  /**
   * The graph node an agent means: a workspace path or address names one PLC's object; a bare name is enough in
   * a workspace with one PLC, else it must say which (PLC_1/Motor or the path).
   */
  const resolveNode = async (graph: CodeGraph, nameOrPath: string): Promise<{ ref: string; device?: string; name: string } | { error: string }> => {
    const states = await stateSnapshot(ctx.root);
    const byPath = states.find((s) => s.path === nameOrPath.replace(/\\/g, "/") || s.address === nameOrPath);
    if (byPath) {
      const a = parseAddress(byPath.address);
      return { ref: graph.key(a.name, a.device), device: a.device, name: a.name };
    }
    const bare = nameOrPath.replace(/^"|"$/g, "");
    const exact = graph.get(bare);
    if (exact && exact.id === bare.toUpperCase()) return { ref: exact.id, ...(exact.device ? { device: exact.device } : {}), name: exact.name };
    const hits = graph.find(bare);
    if (hits.length > 1) return { error: `${bare} is in several PLCs; name one: ${hits.map((h) => (h.device ? `${h.device}/${h.name}` : h.name)).join(" or ")}, or pass its workspace path` };
    return { ref: hits[0]?.id ?? bare, ...(hits[0]?.device ? { device: hits[0].device } : {}), name: hits[0]?.name ?? bare };
  };

  server.registerTool("rung_status", { description: "Sync status of the workspace: object counts, conflicts, pending deletes, recovery items, whether rung watch is running." }, async () => {
    const none = noWorkspace();
    if (none) return none;
    const live = await withOwner((o) => o.request("status"));
    if (live) return json({ watching: true, ...(live as object) });
    const all = await stateSnapshot(ctx.root);
    const by = (s: string) => all.filter((o) => o.status === s).map((o) => o.path);
    return json({ watching: false, objects: all.length, conflicted: by("conflicted"), fileDirty: by("fileDirty"), pendingDelete: by("pendingDelete"), recoveryRequired: by("recoveryRequired"), readOnly: all.filter((o) => o.readOnly).map((o) => o.path) });
  });

  server.registerTool("rung_sync", { description: "Run one two-way sync pass now: sends edited files to TIA Portal, brings TIA changes into files, compiles what was imported. Returns counts, warnings and diagnostics." }, async () => {
    const none = noWorkspace();
    if (none) return none;
    const viaOwner = await withOwner((o) => o.request<SyncReport | null>("syncNow"));
    if (viaOwner !== undefined) return viaOwner ? json(viaOwner) : fail("rung watch is backing off after a bridge error; check rung_status");
    if (!ctx.bridgeFactory) return fail("No rung watch is running and no bridge is configured. Ask the human to start `rung watch`.");
    const config = await loadConfig(ctx.root);
    const bridge = await ctx.bridgeFactory();
    try {
      const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
      try {
        return json(await syncOnce(ctx.root, bridge, state, { config }));
      } finally {
        await state.close();
      }
    } finally {
      await bridge.close();
    }
  });

  server.registerTool(
    "rung_diagnostics",
    { description: "Problems for one file or the whole workspace: SCL syntax/semantic checks plus TIA Portal compile errors and sync conflicts from the last sync.", inputSchema: { path: z.string().optional().describe("workspace-relative file, e.g. plc/PLC_1/blocks/Fx_Motor.scl") } },
    async ({ path: given }) => {
      const { index } = await model();
      const path = given === undefined ? undefined : workspacePath(ctx.root, given);
      // a mistyped path would look like a file without problems
      if (path !== undefined && !index.docs.has(uriOf(join(ctx.root, ...path.split("/")))) && !existsSync(join(ctx.root, ...path.split("/"))))
        return fail(`${path} is not a file of this workspace${meant(nearestPath(path, [...index.docs.keys()].map(pathOf)))} (rung_list lists the mirrored objects)`);
      const sync = (await syncDiagnostics(ctx.root)).filter((d) => !path || d.path === path);
      const files = path ? [uriOf(join(ctx.root, ...path.split("/")))] : [...index.docs.keys()];
      const parsed = files.flatMap((uri) => {
        const doc = index.docs.get(uri);
        if (!doc) return [];
        return parseDiagnostics(index, uri).map((d) => ({ path: pathOf(uri), line: doc.lines.position(d.start).line + 1, severity: d.severity, code: d.code, message: d.message }));
      });
      return json({ sync, source: parsed });
    },
  );

  server.registerTool(
    "rung_compile",
    {
      description: "Compile objects in TIA Portal (needs rung watch or a bridge) and return compiler messages.",
      inputSchema: { addresses: z.array(z.string()).optional().describe("addresses (plc:PLC_1/blocks/Fx_Motor) or workspace paths of the objects; none: the whole PLC"), device: z.string().optional() },
    },
    async ({ addresses: given, device }) => {
    const none = noWorkspace();
    if (none) return none;
    const addresses: string[] = [];
    for (const a of given ?? []) {
      const s = await objectOf(a);
      if (!s && !a.startsWith("plc:")) return fail(`${a} is not a mirrored object${await meantObject(a)} (rung_list lists them)`);
      addresses.push(s?.address ?? a);
    }
    const r = await withOwner((o) => o.request("compile", { addresses, device }));
    if (r !== undefined) return json(r);
    if (!ctx.bridgeFactory) return fail("No rung watch is running; start it to compile from the agent.");
    const config = await loadConfig(ctx.root).catch(() => undefined);
    const b = await ctx.bridgeFactory();
    try {
      const dev = device ?? (await onlyDevice(b, config?.devices ?? []));
      if (!dev) return fail(`The project has several PLCs (${(await b.projectInfo()).devices.join(", ")}); pass device.`);
      const msgs = await b.compile(dev, addresses);
      const states = await stateSnapshot(ctx.root);
      return json(await placeCompileMessages(ctx.root, (a) => states.find((s) => s.address === a)?.path, msgs, (f) => readFile(f, "utf8")));
    } finally {
      await b.close();
    }
    },
  );

  server.registerTool(
    "rung_compare",
    {
      description:
        "Compare the TIA project with what runs on the PLC, like TIA Portal's online/offline comparison (read-only: goes online, compares, goes offline). Lists objects that differ, exist only in the project or only on the PLC. Uses the connection in rung.toml [plc.<device>]; if there is none, ask the person to run `rung connect` once.",
      inputSchema: { device: z.string().optional() },
    },
    async ({ device }) => {
      const none = noWorkspace();
      if (none) return none;
      const config = await loadConfig(ctx.root);
      const withFiles = async (r: CompareOutcome) => {
        const states = await stateSnapshot(ctx.root);
        return { ...r, items: r.items.map((i) => ({ ...i, file: i.address ? states.find((s) => s.address === i.address)?.path : undefined })) };
      };
      const owner = await OwnerClient.connect(ctx.root);
      const b = owner ? undefined : await ctx.bridgeFactory?.();
      try {
        if (!owner && !b) return fail("No rung watch is running and no bridge is available.");
        // the PLC rung mirrors, else the project's only one: never a guessed name
        const chosen = await chooseDevice(device, owner ? () => owner.request("projectInfo") : () => b!.projectInfo());
        if ("problem" in chosen) return fail(chosen.problem);
        const target = config.plc[chosen.device];
        if (owner) return json(await withFiles(await owner.request<CompareOutcome>("compare", { device: chosen.device, ...(target ? { target } : {}) })));
        if (!b!.compare) return fail("This bridge cannot compare with the PLC.");
        return json(await withFiles(await b!.compare(chosen.device, target)));
      } finally {
        owner?.close();
        await b?.close();
      }
    },
  );

  server.registerTool(
    "rung_assignments",
    { description: "The assignment list, like TIA Portal's: every input, output, bit memory, timer and counter address in use, with its tags and where the code uses it, and overlapping accesses (crossing ones are usually mistakes). Read before choosing a free address." },
    async () => {
      const { index } = await model();
      const r = assignmentList(index);
      const rel = (u: { uri: string; line: number }) => `${relative(ctx.root, fileURLToPath(u.uri)).split(sep).join("/")}:${u.line + 1}`;
      return json({ items: r.items.map((a) => ({ ...a, uses: a.uses.map(rel) })), crossing: r.overlaps.filter((o) => !o.nested), nestedCount: r.overlaps.filter((o) => o.nested).length });
    },
  );

  server.registerTool("rung_find_usages", { description: "Every block that calls, instantiates, reads or writes a block, DB, UDT or tag (with the members touched).", inputSchema: { name: z.string().describe("object name, e.g. Fx_Global, or a workspace path") } }, async ({ name }) => {
    const { index, graph } = await model();
    const r = await resolveNode(graph, name);
    if ("error" in r) return fail(r.error);
    if (!graph.get(r.ref)) return fail(`${name} is not in the workspace graph${await meantName(index, name)}`);
    return json(graph.usages(r.ref).map((u) => ({ by: graph.label(u.node), kind: u.node.kind, how: u.kind, count: u.count, ...(u.members ? { members: u.members } : {}) })));
  });

  server.registerTool(
    "rung_graph",
    { description: "Dependency queries over the code graph: callers, callees, impact (transitive dependants) or path (from name to `to`).", inputSchema: { query: z.enum(["callers", "callees", "impact", "path"]), name: z.string(), to: z.string().optional() } },
    async ({ query, name, to }) => {
      const { index, graph } = await model();
      const r = await resolveNode(graph, name);
      if ("error" in r) return fail(r.error);
      const n = r.ref;
      if (!graph.get(n)) return fail(`${name} is not in the workspace graph${await meantName(index, name)}`);
      switch (query) {
        case "callers":
          return json(graph.callers(n).map((x) => graph.label(x)));
        case "callees":
          return json(graph.callees(n).map((x) => ({ name: graph.label(x), kind: x.kind })));
        case "impact":
          return json(graph.impact(n).map((i) => ({ name: graph.label(i.node), kind: i.node.kind, distance: i.distance, via: i.via })));
        case "path": {
          if (!to) return fail("path needs `to`");
          const t = await resolveNode(graph, r.device && !to.includes("/") && graph.find(to).length > 1 ? `${r.device}/${to}` : to);
          if ("error" in t) return fail(t.error);
          const p = graph.path(n, t.ref);
          return p ? json(p.map((x) => graph.label(x))) : text("no dependency path");
        }
      }
    },
  );

  server.registerTool("rung_explain", { description: "What an object is: file, kind, interface (inputs/outputs/statics), read-only flag, sync status and who uses it.", inputSchema: { name: z.string().describe("object name, address or workspace path") } }, async ({ name }) => {
    const { index, graph } = await model();
    const r = await resolveNode(graph, name);
    if ("error" in r) return fail(r.error);
    // seen from a file of that PLC, the name is that PLC's object
    const g = index.global(r.name, r.device ? uriOf(join(ctx.root, "plc", r.device, "_")) : undefined);
    if (!g) return fail(`${name} is not in the workspace${await meantName(index, name)}`);
    const st = (await stateSnapshot(ctx.root)).find((s) => uriOf(join(ctx.root, ...s.path.split("/"))) === g.uri);
    const b = g.block;
    return json({
      name: g.name,
      kind: g.kind,
      path: st?.path ?? g.uri,
      address: st?.address,
      readOnly: st?.readOnly ?? false,
      status: st?.status,
      ...(g.tag ? { tag: g.tag } : {}),
      ...(b ? { dbOf: b.dbOf, returnType: b.returnType, interface: b.vars.map((v) => ({ section: v.section, name: v.name, type: v.type, ...(v.comment ? { comment: v.comment } : {}) })), regions: b.regions.map((r) => r.name) } : {}),
      usedBy: graph.usages(r.ref).map((u) => `${graph.label(u.node)} (${u.kind})`),
    });
  });

  server.registerTool("rung_diff", { description: "Unified diff of a file against the version last synced with TIA Portal (what a sync would send).", inputSchema: { path: z.string() } }, async ({ path: given }) => {
    const none = noWorkspace();
    if (none) return none;
    const path = workspacePath(ctx.root, given);
    const st = (await stateSnapshot(ctx.root)).find((s) => s.path === path);
    const current = await readFile(join(ctx.root, ...path.split("/")), "utf8").catch(() => null);
    if (!st) return current === null ? fail(`${path} not found${await meantObject(path)}`) : text(`${path} is new (not in TIA Portal yet)`);
    const primary = st.files.find((f) => f.role === "primary")!;
    const base = (await new BlobStore(ctx.root).get(primary.hash)).toString("utf8");
    return text(unifiedDiff(normalizeText(base), current === null ? "" : normalizeText(current), `${path} (TIA, last sync)`, `${path} (workspace)`));
  });

  server.registerTool("rung_list", { description: "List mirrored objects, optionally filtered by status or path prefix (plc/PLC_1/blocks/).", inputSchema: { status: z.enum(STATUSES).optional(), prefix: z.string().optional() } }, async ({ status, prefix }) => {
    const none = noWorkspace();
    if (none) return none;
    const all = await stateSnapshot(ctx.root);
    const from = prefix === undefined ? undefined : workspacePath(ctx.root, prefix);
    return json(all.filter((s) => (!status || s.status === status) && (!from || s.path.startsWith(from))).map((s) => ({ path: s.path, address: s.address, form: s.form, status: s.status, readOnly: s.readOnly })));
  });

  server.registerTool(
    "rung_resolve",
    { description: "Resolve a sync conflict: 'theirs' takes TIA's version, 'ours'/'merged' keeps the current file (edit it first to merge) and sends it on the next sync.", inputSchema: { path: z.string(), mode: z.enum(["ours", "theirs", "merged"]) } },
    async ({ path: given, mode }) => {
      const none = noWorkspace();
      if (none) return none;
      // the file itself, or one of the helper files a conflict writes next to it
      const path = workspacePath(ctx.root, given).replace(/\.(conflict|tia)$/, "");
      if (!(await objectOf(path))) return fail(`${path} is not a mirrored file${await meantObject(path, (s) => s.status === "conflicted" || s.status === "recoveryRequired")} (rung_list with status conflicted lists the conflicts)`);
      const viaOwner = await withOwner((o) => o.request("resolve", { path, mode }));
      if (viaOwner === undefined) {
        const config = await loadConfig(ctx.root);
        const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
        try {
          await resolveConflict(ctx.root, state, path, mode);
        } finally {
          await state.close();
        }
      }
      return text(`resolved ${path} (${mode})`);
    },
  );

  server.registerTool(
    "rung_rename",
    {
      description:
        "Rename a block, PLC data type or tag table in TIA Portal. TIA keeps every call, instance DB and access pointing at it; rung moves the file and brings back every file and unit test that used the old name. Never rename by editing a block header: that creates a second block. The file must be synced first.",
      inputSchema: { address: z.string().describe("address or workspace path of the object"), newName: z.string() },
    },
    async ({ address, newName }) => {
      const none = noWorkspace();
      if (none) return none;
      const target = (await objectOf(address))?.address;
      if (!target) return fail(`${address} is not a mirrored object${await meantObject(address)} (rung_list lists them)`);
      const viaOwner = await withOwner((o) => o.request<RenameReport>("rename", { address: target, newName }));
      if (viaOwner !== undefined) return json(viaOwner);
      if (!ctx.bridgeFactory) return fail("No rung watch is running and no bridge is available.");
      const config = await loadConfig(ctx.root);
      const b = await ctx.bridgeFactory();
      try {
        const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
        try {
          return json(await renameObject(ctx.root, b as never, state, config, target, newName));
        } finally {
          await state.close();
        }
      } finally {
        await b.close();
      }
    },
  );

  server.registerTool("rung_confirm_delete", { description: "Delete an object in TIA Portal after its files were deleted in the workspace. Only for objects in pendingDelete; refuses if TIA changed meanwhile.", inputSchema: { address: z.string().describe("address or workspace path of the deleted object") } }, async ({ address: given }) => {
    const none = noWorkspace();
    if (none) return none;
    const found = (await objectOf(given))?.address;
    if (!found && !given.startsWith("plc:")) return fail(`${given} is not a mirrored object${await meantObject(given, (s) => s.status === "pendingDelete")} (rung_list with status pendingDelete lists what waits for it)`);
    const address = found ?? given;
    const viaOwner = await withOwner((o) => o.request("confirmDelete", { address }));
    if (viaOwner !== undefined) return text(`deleted ${address}`);
    if (!ctx.bridgeFactory) return fail("No rung watch is running; start it first.");
    const config = await loadConfig(ctx.root);
    const b = await ctx.bridgeFactory();
    try {
      const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
      try {
        await confirmDelete(ctx.root, b as never, state, address);
      } finally {
        await state.close();
      }
    } finally {
      await b.close();
    }
    return text(`deleted ${address}`);
  });

  server.registerTool(
    "rung_live_read",
    { description: "Read current values from the running PLC (S7-1500 Web API, read-only). Needs [live.webapi] in rung.toml and RUNG_WEBAPI_PASSWORD. Use TIA names, e.g. \"Fx_Global\".Counter.", inputSchema: { names: z.array(z.string()).min(1).max(100) } },
    async ({ names }) => {
      const none = noWorkspace();
      if (none) return none;
      const config = await loadConfig(ctx.root);
      const w = config.live?.webapi;
      const env = ctx.env ?? process.env;
      const password = env.RUNG_WEBAPI_PASSWORD;
      if (!w || !password) return fail("Live reads are not configured: add [live.webapi] url/user to rung.toml and set RUNG_WEBAPI_PASSWORD.");
      // as rung live: the login sends the password
      const refused = plainHttpRefusal(w.url, env);
      if (refused) return fail(refused);
      const client = new WebApiClient({ url: w.url, user: w.user, password, ...(w.insecure ? { insecure: true } : {}) });
      try {
        return json(await client.read(names));
      } catch (e) {
        return fail(`PLC read failed: ${(e as Error).message}`);
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
  );

  server.registerTool(
    "rung_test",
    { description: "Run the workspace unit tests (tests/**/*.test.yaml: set inputs, run cycles, advance virtual time, expect outputs) on rung's offline simulator (SCL, LAD, FBD, STL, structured text). Not a PLCSIM run: good for logic, not for timing-exact or system-instruction behaviour.", inputSchema: { filter: z.string().optional() } },
    async ({ filter }) => {
      const { index } = await model();
      const results = await runTests(ctx.root, index, filter);
      if (!results.length && filter) {
        const all = (await runTests(ctx.root, index)).length;
        if (all) return text(`No tests match "${filter}" (by file path or block name); tests/**/*.test.yaml has ${all} file${all === 1 ? "" : "s"}.`);
      }
      if (!results.length) return text("No tests found. Add tests/<name>.test.yaml (see rung docs: block, cases, steps set/cycle/advance/expect).");
      return json(results);
    },
  );

  server.registerTool("rung_rules", { description: "Safety rules agents must follow in a rung workspace." }, async () => text(SAFETY_RULES));

  server.registerTool(
    "rung_check",
    { description: "What is installed on this PC (TIA Portal, Openness, PLCSIM, TwinCAT, CODESYS, editors, agents), what each enables, and what the person must install for a task. Call it before telling someone to use a tool they may not have.", inputSchema: {} },
    async () => json(await runChecks(realProbes(ctx.env ?? process.env, ctx.bridgeWhitelisted ?? (async () => "unknown")))),
  );

  server.registerTool(
    "rung_download_request",
    {
      description: "Prepare a download for a person: changed files, compile state, what TIA Portal will likely ask (stop CPU, reinitialise DBs), connection and a machine test plan. Written to .rung/download-request.md. Agents never download.",
      inputSchema: {
        device: z.string().optional(),
        summary: z.string().optional().describe("what changed and why, for the person who downloads"),
        testPlan: z.string().optional().describe("steps to test the change on the machine"),
        interfaceChanges: z.array(z.string()).optional().describe("FBs whose interface changed"),
      },
    },
    async ({ device, summary, testPlan, interfaceChanges }) => {
      const none = noWorkspace();
      if (none) return none;
      const config = await loadConfig(ctx.root);
      const chosen = await chooseDevice(device);
      if ("problem" in chosen) return fail(chosen.problem);
      const dev = chosen.device;
      const conn = config.plc[dev];
      const errors = (await syncDiagnostics(ctx.root)).filter((d) => d.severity === "error" && !/^Compiling finished/.test(d.message));
      return text(
        await handover({
          root: ctx.root,
          device: dev,
          ...(summary ? { summary } : {}),
          ...(testPlan ? { testPlan } : {}),
          ...(interfaceChanges ? { interfaceChanges } : {}),
          ...(conn ? { connection: { pcInterface: conn.pcInterface, ...(conn.targetInterface ? { targetInterface: conn.targetInterface } : {}) } } : {}),
          compileErrors: errors.map((e) => ({ path: e.path, ...(e.line ? { line: e.line } : {}), message: e.message })),
        }),
      );
    },
  );

  server.registerResource("status", "rung://status", { description: "Workspace sync status (JSON)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify((await withOwner((o) => o.request("status"))) ?? { watching: false, objects: (await stateSnapshot(ctx.root)).length }) }],
  }));
  server.registerResource("diagnostics", "rung://diagnostics", { description: "Diagnostics from the last sync (JSON)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await syncDiagnostics(ctx.root)) }],
  }));
  server.registerResource("graph", "rung://graph", { description: "Code graph: nodes and call/instance/type/read/write edges (JSON)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify((await model()).graph.toJSON()) }],
  }));

  return server;
}
