// SPDX-License-Identifier: BUSL-1.1
// rung mcp: a small, agent-native tool surface. Agents read and edit the mirrored files directly;
// the tools cover what files cannot tell: sync, compile, diagnostics, graph, conflicts and safety.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffIndices } from "node-diff3";
import { BlobStore, loadConfig, normalizeText, StateStore, type ObjectState } from "@rung/core";
import { OwnerClient, confirmDelete, placeCompileMessages, resolveConflict, syncOnce, type Diagnostic, type SyncBridge, type SyncReport } from "@rung/sync";
import { WorkspaceIndex, diagnostics as parseDiagnostics, uriOf } from "@rung/lsp";
import { CodeGraph } from "@rung/graph";
import { WebApiClient } from "@rung/live";
import { runTests } from "@rung/sim";

export interface McpContext {
  root: string;
  /** Environment for secrets such as RUNG_WEBAPI_PASSWORD (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Starts a bridge for one-off operations when no `rung watch` owner is running. */
  bridgeFactory?: () => Promise<SyncBridge & { close(): Promise<void>; deleteObject?(a: string, e: string, o: string): Promise<unknown> }>;
}

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): Text => text(JSON.stringify(v, null, 2));
const fail = (t: string): Text => ({ content: [{ type: "text", text: t }], isError: true });

export const SAFETY_RULES = `rung safety rules for agents
1. Edit the mirrored files under plc/ directly; changes reach TIA Portal through rung sync / rung watch.
2. Never edit read-only objects: *.protected.yaml (know-how protected), failsafe (F_*) blocks, system blocks, GRAPH blocks. rung refuses to import them.
3. Never download to a PLC. rung has no download command; ask the human to download from TIA Portal after reviewing the change.
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
  const resolveName = async (nameOrPath: string) => {
    const states = await stateSnapshot(ctx.root);
    const byPath = states.find((s) => s.path === nameOrPath.replace(/\\/g, "/") || s.address === nameOrPath);
    if (byPath) return byPath.address.split("/").pop()!.split("~").pop()!.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return nameOrPath.replace(/^"|"$/g, "");
  };

  server.registerTool("rung_status", { description: "Sync status of the workspace: object counts, conflicts, pending deletes, recovery items, whether rung watch is running." }, async () => {
    const live = await withOwner((o) => o.request("status"));
    if (live) return json({ watching: true, ...(live as object) });
    const all = await stateSnapshot(ctx.root);
    const by = (s: string) => all.filter((o) => o.status === s).map((o) => o.path);
    return json({ watching: false, objects: all.length, conflicted: by("conflicted"), fileDirty: by("fileDirty"), pendingDelete: by("pendingDelete"), recoveryRequired: by("recoveryRequired"), readOnly: all.filter((o) => o.readOnly).map((o) => o.path) });
  });

  server.registerTool("rung_sync", { description: "Run one two-way sync pass now: sends edited files to TIA Portal, brings TIA changes into files, compiles what was imported. Returns counts, warnings and diagnostics." }, async () => {
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
    async ({ path }) => {
      const { index } = await model();
      const sync = (await syncDiagnostics(ctx.root)).filter((d) => !path || d.path === path);
      const files = path ? [uriOf(join(ctx.root, ...path.split("/")))] : [...index.docs.keys()];
      const parsed = files.flatMap((uri) => {
        const doc = index.docs.get(uri);
        if (!doc) return [];
        return parseDiagnostics(index, uri).map((d) => ({ path: uri.slice(uriOf(ctx.root).length + 1), line: doc.lines.position(d.start).line + 1, severity: d.severity, code: d.code, message: d.message }));
      });
      return json({ sync, source: parsed });
    },
  );

  server.registerTool("rung_compile", { description: "Compile objects in TIA Portal (needs rung watch or a bridge) and return compiler messages.", inputSchema: { addresses: z.array(z.string()).optional(), device: z.string().optional() } }, async ({ addresses, device }) => {
    const r = await withOwner((o) => o.request("compile", { addresses: addresses ?? [], device }));
    if (r !== undefined) return json(r);
    if (!ctx.bridgeFactory) return fail("No rung watch is running; start it to compile from the agent.");
    const config = await loadConfig(ctx.root).catch(() => undefined);
    const dev = device ?? config?.devices[0] ?? Object.keys(config?.plc ?? {})[0] ?? "PLC_1";
    const b = await ctx.bridgeFactory();
    try {
      const msgs = await b.compile(dev, addresses ?? []);
      const states = await stateSnapshot(ctx.root);
      return json(await placeCompileMessages(ctx.root, (a) => states.find((s) => s.address === a)?.path, msgs, (f) => readFile(f, "utf8")));
    } finally {
      await b.close();
    }
  });

  server.registerTool("rung_find_usages", { description: "Every block that calls, instantiates, reads or writes a block, DB, UDT or tag (with the members touched).", inputSchema: { name: z.string().describe("object name, e.g. Fx_Global, or a workspace path") } }, async ({ name }) => {
    const { graph } = await model();
    const n = await resolveName(name);
    if (!graph.get(n)) return fail(`${n} is not in the workspace graph`);
    return json(graph.usages(n).map((u) => ({ by: u.node.name, kind: u.node.kind, how: u.kind, count: u.count, ...(u.members ? { members: u.members } : {}) })));
  });

  server.registerTool(
    "rung_graph",
    { description: "Dependency queries over the code graph: callers, callees, impact (transitive dependants) or path (from name to `to`).", inputSchema: { query: z.enum(["callers", "callees", "impact", "path"]), name: z.string(), to: z.string().optional() } },
    async ({ query, name, to }) => {
      const { graph } = await model();
      const n = await resolveName(name);
      if (!graph.get(n)) return fail(`${n} is not in the workspace graph`);
      switch (query) {
        case "callers":
          return json(graph.callers(n).map((x) => x.name));
        case "callees":
          return json(graph.callees(n).map((x) => ({ name: x.name, kind: x.kind })));
        case "impact":
          return json(graph.impact(n).map((i) => ({ name: i.node.name, kind: i.node.kind, distance: i.distance, via: i.via })));
        case "path": {
          if (!to) return fail("path needs `to`");
          const p = graph.path(n, await resolveName(to));
          return p ? json(p.map((x) => x.name)) : text("no dependency path");
        }
      }
    },
  );

  server.registerTool("rung_explain", { description: "What an object is: file, kind, interface (inputs/outputs/statics), read-only flag, sync status and who uses it.", inputSchema: { name: z.string().describe("object name, address or workspace path") } }, async ({ name }) => {
    const { index, graph } = await model();
    const n = await resolveName(name);
    const g = index.global(n);
    if (!g) return fail(`${n} is not in the workspace`);
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
      usedBy: graph.usages(g.name).map((u) => `${u.node.name} (${u.kind})`),
    });
  });

  server.registerTool("rung_diff", { description: "Unified diff of a file against the version last synced with TIA Portal (what a sync would send).", inputSchema: { path: z.string() } }, async ({ path }) => {
    const st = (await stateSnapshot(ctx.root)).find((s) => s.path === path);
    const current = await readFile(join(ctx.root, ...path.split("/")), "utf8").catch(() => null);
    if (!st) return current === null ? fail(`${path} not found`) : text(`${path} is new (not in TIA Portal yet)`);
    const primary = st.files.find((f) => f.role === "primary")!;
    const base = (await new BlobStore(ctx.root).get(primary.hash)).toString("utf8");
    return text(unifiedDiff(normalizeText(base), current === null ? "" : normalizeText(current), `${path} (TIA, last sync)`, `${path} (workspace)`));
  });

  server.registerTool("rung_list", { description: "List mirrored objects, optionally filtered by status (synced, conflicted, fileDirty, pendingDelete, recoveryRequired) or path prefix.", inputSchema: { status: z.string().optional(), prefix: z.string().optional() } }, async ({ status, prefix }) => {
    const all = await stateSnapshot(ctx.root);
    return json(all.filter((s) => (!status || s.status === status) && (!prefix || s.path.startsWith(prefix))).map((s) => ({ path: s.path, address: s.address, form: s.form, status: s.status, readOnly: s.readOnly })));
  });

  server.registerTool(
    "rung_resolve",
    { description: "Resolve a sync conflict: 'theirs' takes TIA's version, 'ours'/'merged' keeps the current file (edit it first to merge) and sends it on the next sync.", inputSchema: { path: z.string(), mode: z.enum(["ours", "theirs", "merged"]) } },
    async ({ path, mode }) => {
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

  server.registerTool("rung_confirm_delete", { description: "Delete an object in TIA Portal after its files were deleted in the workspace. Only for objects in pendingDelete; refuses if TIA changed meanwhile.", inputSchema: { address: z.string() } }, async ({ address }) => {
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
      const config = await loadConfig(ctx.root);
      const w = config.live?.webapi;
      const password = (ctx.env ?? process.env).RUNG_WEBAPI_PASSWORD;
      if (!w || !password) return fail("Live reads are not configured: add [live.webapi] url/user to rung.toml and set RUNG_WEBAPI_PASSWORD.");
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
    { description: "Run the workspace unit tests (tests/**/*.test.yaml: set inputs, run cycles, advance virtual time, expect outputs) on rung's offline SCL simulator. Not a PLCSIM run: good for logic, not for timing-exact or system-instruction behaviour.", inputSchema: { filter: z.string().optional() } },
    async ({ filter }) => {
      const { index } = await model();
      const results = await runTests(ctx.root, index, filter);
      if (!results.length) return text("No tests found. Add tests/<name>.test.yaml (see rung docs: block, cases, steps set/cycle/advance/expect).");
      return json(results);
    },
  );

  server.registerTool("rung_rules", { description: "Safety rules agents must follow in a rung workspace." }, async () => text(SAFETY_RULES));

  server.registerTool("rung_download_request", { description: "Prepare a PLC download. rung never downloads; this returns what the human must do in TIA Portal.", inputSchema: { device: z.string().optional() } }, async ({ device }) =>
    text(
      `rung does not download to PLCs. Ask the human to:\n1. Open TIA Portal and review the changes (rung_status shows what was synced).\n2. Compile ${device ?? "the PLC"} (Software, rebuild all) and check for errors.\n3. Go online, compare offline/online and download with the usual safety checks for the machine.\nNever perform or script the download yourself.`,
    ),
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
