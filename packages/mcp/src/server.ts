// SPDX-License-Identifier: BUSL-1.1
// rung mcp: a small, agent-native tool surface. Agents read and edit the mirrored files directly;
// the tools cover what files cannot tell: sync, compile, diagnostics, graph, conflicts and safety.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { diffIndices } from "node-diff3";
import { BlobStore, loadConfig, normalizeText, parseAddress, realProbes, runChecks, StateStore, type ObjectState, type Probes } from "@rung/core";
import { OwnerClient, cachedXref, confirmDelete, placeCompileMessages, renameObject, resolveConflict, syncOnce, type Diagnostic, type RenameReport, type SyncBridge, type SyncReport } from "@rung/sync";
import { WorkspaceIndex, assignmentList, baseText, interfaceImpact, nearest, diagnostics as parseDiagnostics, uriOf, workspaceTests } from "@rung/lsp";
import { CodeGraph } from "@rung/graph";
import { WebApiClient, plainHttpRefusal, type OnlineReadResult, type OnlineStateResult, type OnlineAlarmResult } from "@rung/live";
import { explainStatic, runTests } from "@rung/sim";
import type { CompareOutcome, ConnectionTarget, XRefEntry } from "@rung/bridge-client";
import { handover } from "./handover.js";
import { reviewChanges } from "./review.js";

export interface McpContext {
  root: string;
  /** Environment for secrets such as RUNG_WEBAPI_PASSWORD (defaults to process.env). */
  env?: Record<string, string | undefined>;
  diagnosticFactory?: (options: { device?: string; limit: number }) => Promise<unknown>;
  liveFactory?: (options: { device?: string; transport?: string }) => Promise<{ readFrame?(names: string[]): Promise<OnlineReadResult>; read?(names: string[]): Promise<unknown>; state?(): Promise<OnlineStateResult>; alarms?(lcid: number): Promise<OnlineAlarmResult>; close(): Promise<void> }>;
  /** Starts a bridge for one-off operations when no `rung watch` owner is running. */
  bridgeFactory?: () => Promise<
    SyncBridge & { close(): Promise<void>; deleteObject?(a: string, e: string, o: string): Promise<unknown>; compare?(device: string, target?: ConnectionTarget): Promise<CompareOutcome>; xref?(address: string): Promise<XRefEntry[]> }
  >;
  /** Whether the bridge is in the Openness whitelist (the CLI knows where the bridge is). */
  bridgeWhitelisted?: () => Promise<"ok" | "missing" | "stale" | "unknown">;
  /** What rung_check looks at; the real PC unless a test gives its own. */
  probes?: Probes;
}

type Text = { content: ({ type: "text"; text: string } | { type: "resource_link"; name: string; uri: string; description: string })[]; structuredContent?: { result: unknown }; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }], structuredContent: { result: t } });
const json = (v: unknown): Text => ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: { result: v } });
const fail = (t: string): Text => ({ content: [{ type: "text", text: t }], isError: true });

const paging = { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() };
function page<T>(items: T[], offset = 0, limit = 50) {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit,
    ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}) };
}

/** Secondary collections share the tool's offset/limit; errors and conflicts are deliberately never shortened. */
function details(value: unknown, offset = 0, limit = 50, key = ""): unknown {
  if (["errors", "warnings", "diagnostics", "failures", "conflicts", "conflicted", "recoveryRequired", "crossing"].includes(key)) return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => details(item, offset, limit));
    return items.length > limit || offset > 0 ? page(items, offset, limit) : items;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, details(item, offset, limit, name)]));
  return value;
}

function diagnosticPage<T extends { severity: string }>(items: T[], offset?: number, limit?: number) {
  const errors = items.filter((d) => d.severity === "error");
  const other = page(items.filter((d) => d.severity !== "error"), offset, limit);
  return { items: [...errors, ...other.items], total: items.length, errorCount: errors.length,
    offset: other.offset, limit: other.limit, ...(other.nextOffset === undefined ? {} : { nextOffset: other.nextOffset }) };
}

/** Hints describe the operation, never grant permission to write. The result envelope also supports text and arrays on older SDKs. */
function toolInfo(name: string) {
  const writes = ["rung_sync", "rung_compile", "rung_rename", "rung_resolve", "rung_confirm_delete", "rung_download_request"].includes(name);
  const destructive = ["rung_sync", "rung_rename", "rung_resolve", "rung_confirm_delete"].includes(name);
  return {
    title: name.replace(/^rung_/, "rung ").replace(/_/g, " "),
    annotations: { readOnlyHint: !writes, destructiveHint: destructive, idempotentHint: !writes,
      openWorldHint: writes || name.startsWith("rung_live_") || ["rung_compare", "rung_xref", "rung_sync_preview"].includes(name) },
    outputSchema: { result: z.unknown() },
    ...(["rung_confirm_delete", "rung_resolve"].includes(name) ? { _meta: { "anthropic/requiresUserInteraction": true } }
      : name === "rung_diff" ? { _meta: { "anthropic/maxResultSizeChars": 20_000 } } : {}),
  };
}

function previewResult(report: SyncReport, offset?: number, limit?: number) {
  const entries = report.plan?.entries ?? [];
  const compact = (e: typeof entries[number]) => {
    const { before, after, ...rest } = e;
    const diff = before === undefined && after === undefined ? undefined : unifiedDiff(before ?? "", after ?? "", e.path + " (before)", e.path + " (after)");
    return { ...rest, ...(diff === undefined ? {} : { diff: diff.slice(0, 1000), ...(diff.length > 1000 ? { diffTruncated: true, diffChars: diff.length } : {}) }) };
  };
  const { plan: _plan, ...counts } = report;
  return { ...counts, plan: { ...page(entries.map(compact), offset, limit ?? 5),
    conflicts: entries.filter((e) => e.action === "conflict").map(({ before: _before, after: _after, ...entry }) => entry),
    compile: page(report.plan?.compile ?? [], offset, limit ?? 20) } };
}

export const SAFETY_RULES = `rung makes a TIA Portal project available as plain files. In a folder with rung.toml use these tools for PLC/SCL tasks: explore dependencies, review changes, test offline, compile in TIA Portal and read online state. Read rung_sync_preview before sending a change with rung_sync.

rung safety rules for agents
1. Edit the mirrored files under plc/ directly; changes reach TIA Portal through rung sync / rung watch.
2. Never edit read-only objects: *.protected.yaml (know-how protected), failsafe (F_*) blocks, system blocks, GRAPH blocks. rung refuses to import them.
3. Never download to a PLC, never run rung download, rung live modify/run/stop/force, acknowledge alarms or turn writes on. Never use --yes or --confirm-stdin to approve a PLC change. Prepare the download with rung_download_request; the person downloads after reviewing the change (rung download asks them to type the PLC name).
4. Resolve conflicts only with rung_resolve (keep the file, take TIA's version, or save a merged file first).
5. Run rung_find_usages before changing an interface (VAR_INPUT/OUTPUT/IN_OUT, UDT members, DB layout): every caller and instance DB is affected. After the change, rung_impact tells what breaks against the version TIA Portal has; fix it before the sync.
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
  const server = new McpServer({ name: "rung", version: "0.3.1" }, { instructions: SAFETY_RULES });
  let lastSync: SyncReport | undefined;
  const syncResult = (report: SyncReport) => {
    lastSync = report;
    const result = json(details(report));
    result.content.push({ type: "resource_link", name: "Last sync report", uri: "rung://sync/0", description: "Read additional report pages without repeating the sync. Next sync replaces this snapshot." });
    return result;
  };
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

  server.registerTool(
    "rung_status",
    { ...toolInfo("rung_status"), inputSchema: paging, description: "Sync status of the workspace: object counts, conflicts, pending deletes, recovery items, whether rung watch is running, whether writes to TIA Portal are on (the person turns them on; never you)." },
    async ({ offset, limit }) => {
      const none = noWorkspace();
      if (none) return none;
      const config = await loadConfig(ctx.root).catch(() => undefined);
      const writes = !config ? undefined : config.writesOff ? "off: the person turns them on with rung writes on" : config.sync.import === "auto" ? "on" : "off (sync.import = manual)";
      const live = await withOwner((o) => o.request("status"));
      if (live) return json(details({ watching: true, writes, ...(live as object) }, offset, limit));
      const all = await stateSnapshot(ctx.root);
      const by = (s: string) => all.filter((o) => o.status === s).map((o) => o.path);
      return json(details({ watching: false, writes, objects: all.length, conflicted: by("conflicted"), fileDirty: by("fileDirty"), pendingDelete: by("pendingDelete"), recoveryRequired: by("recoveryRequired"), readOnly: all.filter((o) => o.readOnly).map((o) => o.path) }, offset, limit));
    },
  );

  server.registerTool("rung_sync_preview", { ...toolInfo("rung_sync_preview"),
    description: "Preview one sync without writing: counts, conflicts and paged unified diffs (at most 1000 characters each). Show the person before sending with rung_sync. Use rung_diff for a complete file diff.",
    inputSchema: paging,
  }, async ({ offset, limit }) => {
    const none = noWorkspace(); if (none) return none;
    const planned = await withOwner((o) => o.request<SyncReport>("preview"));
    if (planned !== undefined) return json(previewResult(planned, offset, limit));
    if (!ctx.bridgeFactory) return fail("No rung watch is running and no bridge is configured. Ask the human to start `rung watch`.");
    const config = await loadConfig(ctx.root);
    const bridge = await ctx.bridgeFactory();
    try {
      const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
      try {
        return json(previewResult(await syncOnce(ctx.root, bridge, state, { config, preview: true }), offset, limit));
      } finally {
        await state.close();
      }
    } finally {
      await bridge.close();
    }
  });

  server.registerTool(
    "rung_sync",
    { ...toolInfo("rung_sync"),
      description:
        "Run one two-way sync pass now: sends edited files to TIA Portal, brings TIA changes into files, compiles what was imported. Returns counts, warnings and diagnostics. Read rung_sync_preview first and show the plan to the person.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const none = noWorkspace();
      if (none) return none;
      const viaOwner = await withOwner((o) => o.request<SyncReport | null>("syncNow"));
      if (viaOwner !== undefined) return viaOwner ? syncResult(viaOwner) : fail("rung watch is backing off after a bridge error; check rung_status");
      if (!ctx.bridgeFactory) return fail("No rung watch is running and no bridge is configured. Ask the human to start `rung watch`.");
      const config = await loadConfig(ctx.root);
      const bridge = await ctx.bridgeFactory();
      try {
        const state = await StateStore.open(ctx.root, { projectPath: config.project.path, tiaVersion: config.project.tiaVersion, devices: config.devices });
        try {
          return syncResult(await syncOnce(ctx.root, bridge, state, { config }));
        } finally {
          await state.close();
        }
      } finally {
        await bridge.close();
      }
    },
  );

  server.registerTool(
    "rung_diagnostics",
    { ...toolInfo("rung_diagnostics"), description: "Problems for one file or the whole workspace: SCL syntax/semantic checks plus TIA Portal compile errors and sync conflicts from the last sync.", inputSchema: { ...paging, path: z.string().optional().describe("workspace-relative file, e.g. plc/PLC_1/blocks/Fx_Motor.scl") } },
    async ({ path: given, offset, limit }) => {
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
      const syncPage = diagnosticPage(sync, offset, limit), sourcePage = diagnosticPage(parsed, offset, limit);
      return json({ sync: syncPage.items, source: sourcePage.items, counts: { sync: sync.length, source: parsed.length },
        syncPaging: { ...syncPage, items: undefined }, sourcePaging: { ...sourcePage, items: undefined } });
    },
  );

  server.registerTool(
    "rung_compile",
    { ...toolInfo("rung_compile"),
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
    { ...toolInfo("rung_compare"),
      description:
        "Compare the TIA project with what runs on the PLC, like TIA Portal's online/offline comparison (read-only: goes online, compares, goes offline). Lists objects that differ, exist only in the project or only on the PLC. Uses the connection in rung.toml [plc.<device>]; if there is none, ask the person to run `rung connect` once.",
      inputSchema: { ...paging, device: z.string().optional() },
    },
    async ({ device, offset, limit }) => {
      const none = noWorkspace();
      if (none) return none;
      const config = await loadConfig(ctx.root);
      const withFiles = async (r: CompareOutcome) => {
        const states = await stateSnapshot(ctx.root);
        return { ...r, ...page(r.items.map((i) => ({ ...i, file: i.address ? states.find((s) => s.address === i.address)?.path : undefined })), offset, limit) };
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
    { ...toolInfo("rung_assignments"), description: "Paged assignment list: input, output, bit memory, timer and counter addresses. Filter by area or address prefix. Summary includes tag/use counts; summary:false includes tags and uses, paged independently with detailOffset/detailLimit (default 10). Crossing overlaps are always reported. Read before choosing a free address.",
      inputSchema: { ...paging, area: z.enum(["I", "Q", "M", "T", "C"]).optional(), prefix: z.string().optional(), summary: z.boolean().optional(), device: z.string().optional(), detailOffset: z.number().int().min(0).optional(), detailLimit: z.number().int().min(1).max(50).optional() } },
    async ({ offset, limit, area, prefix, summary, device, detailOffset, detailLimit }) => {
      const { index } = await model();
      const r = assignmentList(index, device);
      const rel = (u: { uri: string; line: number }) => `${relative(ctx.root, fileURLToPath(u.uri)).split(sep).join("/")}:${u.line + 1}`;
      const selected = r.items.filter((a) => (!area || a.area === area) && (!prefix || a.address.toUpperCase().startsWith(prefix.toUpperCase())));
      return json({ ...page(selected.map(({ tags, uses, ...a }) => ({ ...a, tagCount: tags.length, useCount: uses.length,
        ...(summary === false ? { tags: page(tags, detailOffset, detailLimit ?? 10), uses: page(uses.map(rel), detailOffset, detailLimit ?? 10) } : {}) })), offset, limit),
        crossing: r.overlaps.filter((o) => !o.nested), nestedCount: r.overlaps.filter((o) => o.nested).length });
    },
  );

  server.registerTool("rung_find_usages", { ...toolInfo("rung_find_usages"), description: "Every block that calls, instantiates, reads or writes a block, DB, UDT or tag (with the members touched).", inputSchema: { ...paging, name: z.string().describe("object name, e.g. Fx_Global, or a workspace path") } }, async ({ name, offset, limit }) => {
    const { index, graph } = await model();
    const r = await resolveNode(graph, name);
    if ("error" in r) return fail(r.error);
    if (!graph.get(r.ref)) return fail(`${name} is not in the workspace graph${await meantName(index, name)}`);
    return json(page(graph.usages(r.ref).map((u) => ({ by: graph.label(u.node), kind: u.node.kind, how: u.kind, count: u.count, ...(u.members ? { members: page(u.members) } : {}) })), offset, limit));
  });

  server.registerTool(
    "rung_why",
    { ...toolInfo("rung_why"), description: "Why a variable of a block has its value, from the code: every statement of the block that writes it, the IF/CASE branch each stands in, and the operands those read, a few levels deep (no PLC values; rung why <file> <name> adds them on a running PLC).", inputSchema: { ...paging, path: z.string().describe("workspace file of the block, e.g. plc/PLC_1/blocks/FB_Motor.scl"), name: z.string().describe("the variable, e.g. Running or #Running"), depth: z.number().int().min(1).max(6).optional() } },
    async ({ path, name, depth, offset, limit }) => {
      const none = noWorkspace();
      if (none) return none;
      const { index } = await model();
      const uri = uriOf(isAbsolute(path) ? path : join(ctx.root, path));
      const now = await readFile(fileURLToPath(uri), "utf8").catch(() => undefined);
      if (now === undefined) return fail(`${path} does not exist`);
      index.set(uri, now, 0);
      try {
        return json(details(explainStatic(index, uri, name, () => undefined, depth ?? 3), offset, limit ?? 10));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "rung_impact",
    { ...toolInfo("rung_impact"), description: "What the interface change of a block file breaks against the version TIA Portal has (the last synced one): parameters and statics that went, came, were renamed or retyped; calls that pass a parameter that went or leave out one an FC now wants; instance DBs TIA Portal reinitialises on download (multi-instances too); unit tests naming what went. Read-only, from the files.", inputSchema: { ...paging, path: z.string().describe("workspace file of an FB, FC or PLC data type, e.g. plc/PLC_1/blocks/FB_Motor.scl") } },
    async ({ path, offset, limit }) => {
      const none = noWorkspace();
      if (none) return none;
      const { index } = await model();
      const uri = uriOf(isAbsolute(path) ? path : join(ctx.root, path));
      const before = await baseText(ctx.root, uri);
      if (before === undefined) return fail(`${path} is not in TIA Portal yet (never synced): nothing uses it there`);
      // the file as the agent just wrote it (the model may be up to 2 s old)
      const now = await readFile(fileURLToPath(uri), "utf8").catch(() => undefined);
      if (now === undefined) return fail(`${path} does not exist`);
      index.set(uri, now, 0);
      const r = interfaceImpact(index, uri, before, await workspaceTests(ctx.root));
      return r ? json(details(r, offset, limit)) : fail(`${path} holds no FB, FC or PLC data type`);
    },
  );

  server.registerTool(
    "rung_graph",
    { ...toolInfo("rung_graph"), description: "Dependency queries over the code graph: callers, callees, impact (transitive dependants) or path (from name to `to`).", inputSchema: { ...paging, query: z.enum(["callers", "callees", "impact", "path"]), name: z.string(), to: z.string().optional() } },
    async ({ query, name, to, offset, limit }) => {
      const { index, graph } = await model();
      const r = await resolveNode(graph, name);
      if ("error" in r) return fail(r.error);
      const n = r.ref;
      if (!graph.get(n)) return fail(`${name} is not in the workspace graph${await meantName(index, name)}`);
      switch (query) {
        case "callers":
          return json(page(graph.callers(n).map((x) => graph.label(x)), offset, limit));
        case "callees":
          return json(page(graph.callees(n).map((x) => ({ name: graph.label(x), kind: x.kind })), offset, limit));
        case "impact":
          return json(page(graph.impact(n).map((i) => ({ name: graph.label(i.node), kind: i.node.kind, distance: i.distance, via: i.via })), offset, limit));
        case "path": {
          if (!to) return fail("path needs `to`");
          const t = await resolveNode(graph, r.device && !to.includes("/") && graph.find(to).length > 1 ? `${r.device}/${to}` : to);
          if ("error" in t) return fail(t.error);
          const p = graph.path(n, t.ref);
          return p ? json(page(p.map((x) => graph.label(x)), offset, limit)) : text("no dependency path");
        }
      }
    },
  );

  server.registerTool("rung_explain", { ...toolInfo("rung_explain"), description: "What an object is: file, kind, interface (inputs/outputs/statics), read-only flag, sync status and who uses it.", inputSchema: { ...paging, name: z.string().describe("object name, address or workspace path") } }, async ({ name, offset, limit }) => {
    const { index, graph } = await model();
    const r = await resolveNode(graph, name);
    if ("error" in r) return fail(r.error);
    // seen from a file of that PLC, the name is that PLC's object
    const g = index.global(r.name, r.device ? uriOf(join(ctx.root, "plc", r.device, "_")) : undefined);
    if (!g) return fail(`${name} is not in the workspace${await meantName(index, name)}`);
    const st = (await stateSnapshot(ctx.root)).find((s) => uriOf(join(ctx.root, ...s.path.split("/"))) === g.uri);
    const b = g.block;
    return json(details({
      name: g.name,
      kind: g.kind,
      path: st?.path ?? g.uri,
      address: st?.address,
      readOnly: st?.readOnly ?? false,
      status: st?.status,
      ...(g.tag ? { tag: g.tag } : {}),
      ...(b ? { dbOf: b.dbOf, returnType: b.returnType, interface: b.vars.map((v) => ({ section: v.section, name: v.name, type: v.type, ...(v.comment ? { comment: v.comment } : {}) })), regions: b.regions.map((r) => r.name) } : {}),
      usedBy: graph.usages(r.ref).map((u) => `${graph.label(u.node)} (${u.kind})`),
    }, offset, limit));
  });

  server.registerTool("rung_diff", { ...toolInfo("rung_diff"), description: "Unified diff of a file against the version last synced with TIA Portal (what a sync would send).", inputSchema: { path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20000).optional() } }, async ({ path: given, offset, limit }) => {
    const none = noWorkspace();
    if (none) return none;
    const path = workspacePath(ctx.root, given);
    const st = (await stateSnapshot(ctx.root)).find((s) => s.path === path);
    const current = await readFile(join(ctx.root, ...path.split("/")), "utf8").catch(() => null);
    if (!st) return current === null ? fail(`${path} not found${await meantObject(path)}`) : text(`${path} is new (not in TIA Portal yet)`);
    const primary = st.files.find((f) => f.role === "primary")!;
    const base = (await new BlobStore(ctx.root).get(primary.hash)).toString("utf8");
    const diff = unifiedDiff(normalizeText(base), current === null ? "" : normalizeText(current), `${path} (TIA, last sync)`, `${path} (workspace)`);
    const start = offset ?? 0, end = start + (limit ?? 8000);
    return text(diff.slice(start, end) + (end < diff.length ? `\n[${diff.length - end} more characters; call rung_diff with offset:${end}]` : ""));
  });

  server.registerTool("rung_list", { ...toolInfo("rung_list"), description: "List mirrored objects, optionally filtered by status or path prefix (plc/PLC_1/blocks/). Defaults to 50 objects; nextOffset continues the list. Counts and conflict paths cover the whole selection.", inputSchema: { ...paging, status: z.enum(STATUSES).optional(), prefix: z.string().optional() } }, async ({ status, prefix, offset, limit }) => {
    const none = noWorkspace();
    if (none) return none;
    const all = await stateSnapshot(ctx.root);
    const from = prefix === undefined ? undefined : workspacePath(ctx.root, prefix);
    const selected = all.filter((s) => (!status || s.status === status) && (!from || s.path.startsWith(from))).sort((a, b) => a.path.localeCompare(b.path));
    return json({ ...page(selected.map((s) => ({ path: s.path, address: s.address, form: s.form, status: s.status, readOnly: s.readOnly })), offset, limit),
      counts: Object.fromEntries(STATUSES.map((status) => [status, selected.filter((s) => s.status === status).length])),
      conflicts: selected.filter((s) => s.status === "conflicted" || s.status === "recoveryRequired").map((s) => s.path) });
  });

  server.registerTool(
    "rung_resolve",
    { ...toolInfo("rung_resolve"), description: "Resolve a sync conflict: 'theirs' takes TIA's version, 'ours'/'merged' keeps the current file (edit it first to merge) and sends it on the next sync.", inputSchema: { path: z.string(), mode: z.enum(["ours", "theirs", "merged"]) } },
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
    { ...toolInfo("rung_rename"),
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

  server.registerTool("rung_confirm_delete", { ...toolInfo("rung_confirm_delete"), description: "Delete an object in TIA Portal after its files were deleted in the workspace. Only for objects in pendingDelete; refuses if TIA changed meanwhile.", inputSchema: { address: z.string().describe("address or workspace path of the deleted object") } }, async ({ address: given }) => {
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
    { ...toolInfo("rung_live_read"), description: "Read current values from the selected PLC through the shared read-only backend, with target and observation provenance. Use TIA names, e.g. \"Fx_Global\".Counter. Pass device in a multi-PLC workspace.", inputSchema: { names: z.array(z.string()).min(1).max(100), device: z.string().optional(), transport: z.enum(["s7commplus", "webapi"]).optional() } },
    async ({ names, device, transport }) => {
      const none = noWorkspace();
      if (none) return none;
      if (ctx.liveFactory) {
        let reader: Awaited<ReturnType<NonNullable<McpContext["liveFactory"]>>> | undefined;
        try {
          reader = await ctx.liveFactory({ ...(device ? { device } : {}), ...(transport ? { transport } : {}) });
          return json(reader.readFrame ? await reader.readFrame(names) : await reader.read!(names));
        } catch (e) { return fail(`PLC read failed: ${(e as Error).message}`); }
        finally { await reader?.close(); }
      }
      const config = await loadConfig(ctx.root);
      if (device || transport === "s7commplus" || Object.keys(config.live?.plc ?? {}).length) return fail("Start this server with rung mcp to use the configured shared PLC backend.");
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

  for (const kind of ["state", "alarms"] as const) server.registerTool(`rung_live_${kind}`, { ...toolInfo(`rung_live_${kind}`),
    description: kind === "state" ? "Read the selected PLC's CPU mode, cycle and memory with identity and target provenance."
      : "Read active PLC alarms, preserving raw IDs, CPU timestamps, receive timestamps and text language provenance. No alarm acknowledgement is exposed.",
    inputSchema: { ...paging, device: z.string().optional(), transport: z.enum(["s7commplus", "webapi"]).optional(), lcid: z.number().int().min(1).max(65535).optional() },
  }, async ({ device, transport, lcid, offset, limit }) => {
    const none = noWorkspace(); if (none) return none;
    if (!ctx.liveFactory) return fail("Start with rung mcp for shared PLC diagnostics.");
    let reader: Awaited<ReturnType<NonNullable<McpContext["liveFactory"]>>> | undefined;
    try {
      reader = await ctx.liveFactory({ ...(device ? { device } : {}), ...(transport ? { transport } : {}) });
      if (kind === "state") return reader.state ? json(await reader.state()) : fail("CPU diagnostics unavailable for this transport.");
      if (!reader.alarms) return fail("Alarms unavailable for this transport.");
      const alarms = await reader.alarms(lcid ?? 1033);
      const selected = page(alarms.alarms, offset, limit);
      return json({ ...alarms, alarms: selected.items, total: selected.total, offset: selected.offset, limit: selected.limit, ...(selected.nextOffset === undefined ? {} : { nextOffset: selected.nextOffset }) });
    } catch (error) { return fail(`PLC ${kind} unavailable: ${(error as Error).message}`); }
    finally { await reader?.close(); }
  });

  server.registerTool("rung_live_diag", { ...toolInfo("rung_live_diag"),
    description: "Read the PLC diagnostic buffer through the configured read-only Web API fallback. Keeps raw IDs and CPU timestamps. No acknowledgement or PLC changes.",
    inputSchema: { device: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async ({ device, limit }) => {
    const none = noWorkspace(); if (none) return none;
    if (!ctx.diagnosticFactory) return fail("Start with rung mcp for the configured read-only diagnostic buffer backend.");
    try { return json(await ctx.diagnosticFactory({ ...(device ? { device } : {}), limit: limit ?? 50 })); }
    catch (error) { return fail(`PLC diagnostic buffer unavailable: ${(error as Error).message}`); }
  });

  server.registerTool(
    "rung_test",
    { ...toolInfo("rung_test"), description: "Run the workspace unit tests (tests/**/*.test.yaml: set inputs, run cycles, advance virtual time, expect outputs; { within: 2s, expect: … }, always, never for timing) on rung's offline simulator (SCL, LAD, FBD, STL, structured text). Not a PLCSIM run: good for logic, not for timing-exact or system-instruction behaviour. A file's stubs: map stands in for what the simulator does not model (communication, diagnostics, motion, missing blocks, technology objects); results list what was stubbed. observe: true adds the block's outputs and statics after every step that runs cycles (to write expectations from; check them with the person before they become a test).", inputSchema: { ...paging, filter: z.string().optional(), observe: z.boolean().optional(), verbose: z.boolean().optional(), stepOffset: z.number().int().min(0).optional(), observationLimit: z.number().int().min(1).max(10).optional(), valueOffset: z.number().int().min(0).optional(), valueLimit: z.number().int().min(1).max(50).optional() } },
    async ({ filter, observe, verbose, offset, limit, stepOffset, observationLimit, valueOffset, valueLimit }) => {
      const { index } = await model();
      const results = await runTests(ctx.root, index, filter, undefined, observe ? { observe: true } : {});
      if (!results.length && filter) {
        const all = (await runTests(ctx.root, index)).length;
        if (all) return text(`No tests match "${filter}" (by file path, block name or case name); tests/**/*.test.yaml has ${all} file${all === 1 ? "" : "s"}.`);
      }
      if (!results.length) return text("No tests found. Add tests/<name>.test.yaml (see rung docs: block, cases, steps set/cycle/advance/expect).");
      const cases = results.flatMap((f) => f.cases.map((c) => ({ file: f.file, block: f.block, ...c })));
      const failures = cases.filter((c) => !c.passed).map(({ observed: _observed, ...c }) => c);
      const selected = cases.filter((c) => verbose || observe || !c.passed).map(({ observed, ...c }) => ({ ...c,
        ...(observed ? { observed: page(observed.map(({ values, statics, ...step }) => ({ ...step,
          values: Object.fromEntries(Object.entries(values).slice(valueOffset ?? 0, (valueOffset ?? 0) + (valueLimit ?? 10))),
          valueCount: Object.keys(values).length, valueOffset: valueOffset ?? 0,
          ...((valueOffset ?? 0) + (valueLimit ?? 10) < Object.keys(values).length ? { nextValueOffset: (valueOffset ?? 0) + (valueLimit ?? 10) } : {}),
          ...(statics ? { statics: statics.filter((name) => Object.keys(values).slice(valueOffset ?? 0, (valueOffset ?? 0) + (valueLimit ?? 10)).includes(name)) } : {})
        })), stepOffset, observationLimit ?? 5) } : {}) }));
      return json({ files: results.length, totalCases: cases.length, passed: cases.filter((c) => c.passed).length, failed: failures.length,
        errors: results.filter((f) => f.error).map(({ cases: _cases, ...f }) => f), failures,
        ...page(selected, offset, limit ?? 5),
        stubs: page(results.flatMap((f) => (f.stubbed ?? []).map((s) => ({ file: f.file, ...s }))), offset, limit ?? 10) });
    },
  );

  server.registerTool(
    "rung_xref",
    { ...toolInfo("rung_xref"), description: "TIA Portal's own cross-reference of an object (read-only): who uses it and what it uses, including what the files cannot show (HMI screens, alarms, technology objects, address overlaps). Give a workspace file (plc/PLC_1/blocks/FB_Motor.scl) or an address (plc:PLC_1/blocks/FB_Motor). Needs TIA Portal: through the running rung watch, else a bridge.", inputSchema: { ...paging, object: z.string() } },
    async ({ object, offset, limit }) => {
      const none = noWorkspace();
      if (none) return none;
      const states = await stateSnapshot(ctx.root);
      const root = ctx.root.replace(/\\/g, "/").replace(/\/$/, "");
      let rel = object.replace(/\\/g, "/").replace(/^\.\//, "");
      if (rel.toLowerCase().startsWith(root.toLowerCase() + "/")) rel = rel.slice(root.length + 1); // an absolute path of the workspace
      const bare = rel.replace(/^"|"$/g, "").toLowerCase();
      const address = /^[a-z]+:/i.test(rel) && !/^[a-z]:\//i.test(rel) ? rel : (states.find((s) => s.path === rel) ?? states.find((s) => s.address.toLowerCase().endsWith("/" + bare)))?.address;
      if (!address) return fail(`${object} is not a mirrored object (give its file under plc/ or its address, as rung_list shows them)`);
      const relation: Record<string, string> = { UsedBy: "used by", TypeInstance: "used by", Defines: "used by", GroupMember: "used by", Uses: "uses", InstanceType: "uses", DefinedBy: "uses", MemberGroup: "uses", Assigns: "uses", OverlapsWith: "overlaps" };
      let owner: OwnerClient | undefined;
      let b: Awaited<ReturnType<NonNullable<typeof ctx.bridgeFactory>>> | undefined;
      try {
        // TIA Portal is asked only when the kept answer is older than what is mirrored now
        const ask = async (): Promise<XRefEntry[]> => {
          owner = (await OwnerClient.connect(ctx.root)) ?? undefined;
          if (owner) return owner.request<XRefEntry[]>("xref", { address });
          b = await ctx.bridgeFactory?.().catch(() => undefined);
          if (!b) throw new Error("No rung watch is running and no bridge could start (TIA Portal and its Openness are needed for the cross-reference).");
          if (!b.xref) throw new Error("This bridge has no cross-reference.");
          return b.xref(address);
        };
        const r = await cachedXref(ctx.root, address, ask).catch((e: Error) => e);
        if (r instanceof Error) return fail(r.message);
        const { entries, at } = r;
        return json(details({
          address,
          ...(at ? { cachedAt: new Date(at).toISOString(), note: "TIA Portal's earlier answer: nothing mirrored changed since (HMI screens are not mirrored)" } : {}),
          rows: entries.map((e) => ({ relation: relation[e.referenceType] ?? "related", name: e.targetName, type: e.targetType, access: e.access, ...(e.location ? { location: e.location } : {}), ...(e.target ? { file: states.find((s) => s.address === e.target)?.path } : {}) })),
        }, offset, limit));
      } finally {
        owner?.close();
        await b?.close();
      }
    },
  );

  server.registerTool("rung_rules", { ...toolInfo("rung_rules"), description: "Safety rules agents must follow in a rung workspace." }, async () => text(SAFETY_RULES));

  server.registerTool("rung_review", { ...toolInfo("rung_review"),
    description: "Offline change report for the person approving a change: interfaces, logic by region/network, callers, data blocks and tags. Defaults to working tree against HEAD, or compare a base/head git range. offset/limit page blocks; detailOffset/detailLimit page the collections inside each block independently. Diagnostics stay complete.",
    inputSchema: { ...paging, base: z.string().optional(), head: z.string().optional(), detailOffset: z.number().int().min(0).optional(), detailLimit: z.number().int().min(1).max(100).optional() },
  }, async ({ base, head, offset, limit, detailOffset, detailLimit }) => {
    try {
      const report = await reviewChanges(ctx.root, { ...(base ? { base } : {}), ...(head ? { head } : {}) });
      return json({ ...report, blocks: page(report.blocks.map((b) => ({ ...b,
        interfaceChanges: page(b.interfaceChanges, detailOffset, detailLimit ?? 5), logic: page(b.logic.map((change) => ({ ...change, diff: change.diff.slice(0, 500), truncated: change.truncated || change.diff.length > 500 })), detailOffset, detailLimit ?? 3),
        affected: Object.fromEntries(Object.entries(b.affected).map(([key, names]) => [key, page(names, detailOffset, detailLimit ?? 5)])),
        namesMatched: page(b.namesMatched, detailOffset, detailLimit ?? 5),
      })), offset, limit ?? 3) });
    } catch (error) { return fail((error as Error).message); }
  });

  server.registerTool(
    "rung_check",
    { ...toolInfo("rung_check"), description: "What is installed on this PC (TIA Portal, Openness, PLCSIM, TwinCAT, CODESYS, editors, agents), what each enables, and what the person must install for a task. Call it before telling someone to use a tool they may not have.", inputSchema: {} },
    async () => json(await runChecks(ctx.probes ?? realProbes(ctx.env ?? process.env, ctx.bridgeWhitelisted ?? (async () => "unknown")))),
  );

  server.registerTool(
    "rung_download_request",
    { ...toolInfo("rung_download_request"),
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

  server.registerResource("status", "rung://status", { description: "Workspace sync status; collections are bounded, conflicts stay complete. Page collections with rung_status.", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(details((await withOwner((o) => o.request("status"))) ?? { watching: false, objects: (await stateSnapshot(ctx.root)).length })) }],
  }));
  server.registerResource("diagnostics", "rung://diagnostics", { description: "Diagnostics from the last sync (JSON)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(diagnosticPage(await syncDiagnostics(ctx.root))) }],
  }));
  server.registerResource("diagnostics-page", new ResourceTemplate("rung://diagnostics/{offset}", { list: undefined }),
    { description: "Last-sync diagnostics: every error plus 50 other messages from offset. Errors are never shortened.", mimeType: "application/json" }, async (uri, variables) => {
      const offset = z.coerce.number().int().min(0).parse(variables.offset);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(diagnosticPage(await syncDiagnostics(ctx.root), offset)) }] };
    });
  server.registerResource("sync-page", new ResourceTemplate("rung://sync/{offset}", { list: undefined }),
    { description: "Last sync in this server session, paged without sending anything. Every warning and diagnostic stays complete.", mimeType: "application/json" }, async (uri, variables) => {
      if (!lastSync) throw new Error("No sync has run in this server session.");
      const offset = z.coerce.number().int().min(0).parse(variables.offset);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(details(lastSync, offset)) }] };
    });
  server.registerResource("graph", "rung://graph", { description: "Code graph summary; read rung://graph/{object} for one object and its neighbours.", mimeType: "application/json" }, async (uri) => {
    const { graph } = await model();
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ nodes: graph.nodes.size, edges: graph.edges.length,
      objectResource: "rung://graph/{object}", note: "Use rung_graph with offset/limit to page dependency queries." }) }] };
  });
  server.registerResource("graph-object", new ResourceTemplate("rung://graph/{object}", { list: undefined }),
    { description: "One graph node and its first 50 neighbours; use rung_graph to page more.", mimeType: "application/json" }, async (uri, variables) => {
      const { graph } = await model();
      const resolved = await resolveNode(graph, decodeURIComponent(String(variables.object)));
      const node = "error" in resolved ? undefined : graph.get(resolved.ref);
      if (!node) throw new Error("error" in resolved ? resolved.error : "Object not in workspace graph");
      const edges = graph.edges.filter((e) => e.from === node.id || e.to === node.id);
      const selected = edges.slice(0, 50);
      const neighbours = [...new Set(selected.map((e) => e.from === node.id ? e.to : e.from))].map((id) => graph.get(id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ node, neighbours, edges: page(edges),
        ...(edges.length > 50 ? { note: "More neighbours available with rung_graph and offset/limit." } : {}) }) }] };
    });

  return server;
}
