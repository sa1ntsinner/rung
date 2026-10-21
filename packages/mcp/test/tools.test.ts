// SPDX-License-Identifier: BUSL-1.1
// The MCP tools do what their descriptions promise, and when they cannot, say what to do next.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateStore, defaultConfig, saveConfig, type RungConfig } from "@rung/core";
import { pull } from "@rung/sync";
import { createMcpServer, type McpContext } from "../src/index.js";
import { FakeBridge } from "../../sync/test/fake-bridge.js";

const MOTOR = 'FUNCTION_BLOCK "Fx_Motor"\nVAR_INPUT\n  Start : Bool;\nEND_VAR\nBEGIN\n  #nope := 1;\nEND_FUNCTION_BLOCK\n';

async function connect(root: string, extra: Partial<McpContext> = {}) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ root, ...extra }).connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0]!.text };
  };
}

/** A workspace mirrored from a fake project with one FB on PLC_1. */
async function workspace(cfg: (c: RungConfig) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "rung-mcp-tools-"));
  const bridge = new FakeBridge();
  bridge.add("plc:PLC_1/blocks/Fx_Motor", { content: MOTOR });
  const config = defaultConfig(bridge.info.path, "V20", "fake");
  cfg(config);
  await saveConfig(root, config);
  const state = await StateStore.open(root, { projectPath: bridge.info.path, tiaVersion: "V20", devices: config.devices });
  await pull(root, bridge, state, { config });
  await state.close();
  return { root, bridge, config };
}

describe("rung mcp outside a workspace", () => {
  it("tools that need one say how a person makes one, instead of reporting an empty workspace", async () => {
    // a PC with nothing installed: what rung_check finds is not the point here, and probing a real one can take long
    const probes = { platform: "linux" as const, nodeVersion: "v22.0.0", windows: async () => null, which: () => null, vscodeExtensions: async () => null, zedExtensions: () => null, exists: () => false, home: tmpdir(), bridgeWhitelisted: async () => "unknown" as const };
    const call = await connect(mkdtempSync(join(tmpdir(), "rung-mcp-none-")), { probes });
    for (const tool of ["rung_status", "rung_sync", "rung_list", "rung_compile", "rung_download_request"]) {
      const r = await call(tool);
      expect([tool, r.isError, r.text]).toEqual([tool, true, expect.stringMatching(/is not a rung workspace \(no rung\.toml\)\. A person binds a folder to a project with rung init --project <path to the \.ap20 or \.project>, then rung pull\.$/)]);
    }
    expect((await call("rung_check")).isError).toBe(false);
  });
});

describe("rung mcp tools", () => {
  it("refuses the old sync preview argument before opening a bridge", async () => {
    const { root } = await workspace();
    let opened = false;
    const call = await connect(root, { bridgeFactory: async () => { opened = true; throw new Error("must not start"); } });
    expect((await call("rung_sync", { preview: true })).isError).toBe(true);
    expect(opened).toBe(false);
  });

  it("reads a bounded diagnostic buffer through an injected read-only backend", async () => {
    const { root } = await workspace();
    const asked: unknown[] = [];
    const call = await connect(root, { diagnosticFactory: async (opts) => { asked.push(opts); return { at: 1, entries: [{ rawId: 42, cpuTimestamp: "fixture" }] }; } });
    expect(JSON.parse((await call("rung_live_diag", { device: "PLC_1" })).text).entries[0].rawId).toBe(42);
    expect(asked).toEqual([{ device: "PLC_1", limit: 50 }]);
    expect((await call("rung_live_diag", { limit: 101 })).isError).toBe(true);
    expect(asked).toHaveLength(1);
  });
  it("compare and the download request name the PLC the workspace mirrors, and ask when there are several", async () => {
    const { root } = await workspace();
    const asked: string[] = [];
    const bridge = (devices: string[]) => async () =>
      Object.assign(new FakeBridge(), {
        close: async () => {},
        compile: async () => [],
        projectInfo: async () => ({ name: "X", path: "C:\\fx\\X.ap20", tiaVersion: "V20", devices, isLocalSession: false }),
        compare: async (device: string) => (asked.push(device), { identical: 1, items: [] }),
      });
    expect((await (await connect(root, { bridgeFactory: bridge(["PLC_1"]) }))("rung_compare")).isError).toBe(false);
    expect(asked).toEqual(["PLC_1"]);
    // nothing mirrored yet: the project's only PLC, whatever its name
    const empty = mkdtempSync(join(tmpdir(), "rung-mcp-empty-"));
    await saveConfig(empty, defaultConfig("C:\\fx\\X.ap20", "V20", "fake"));
    await (await connect(empty, { bridgeFactory: bridge(["Line_A"]) }))("rung_compare");
    expect(asked).toEqual(["PLC_1", "Line_A"]);
    const two = await (await connect(empty, { bridgeFactory: bridge(["Line_A", "Line_B"]) }))("rung_compare");
    expect(two).toEqual({ isError: true, text: "The project has several PLCs (Line_A, Line_B); pass device." });
    const request = await (await connect(empty))("rung_download_request");
    expect(request).toEqual({ isError: true, text: "Nothing is mirrored yet, so rung cannot tell which PLC; pass device." });
    const handed = (await (await connect(root))("rung_download_request")).text;
    expect(handed).toMatch(/PLC_1/);
    expect(handed).toMatch(/TIA Portal has the files as they are: all 1 mirrored objects are synced/);
  });

  it("take workspace paths with backslashes, and refuse one that is not a file of the workspace", async () => {
    const { root } = await workspace();
    const call = await connect(root);
    const d = await call("rung_diagnostics", { path: "plc\\PLC_1\\blocks\\Fx_Motor.scl" });
    expect(JSON.parse(d.text).source).toEqual([expect.objectContaining({ path: "plc/PLC_1/blocks/Fx_Motor.scl", code: "UNDECLARED" })]);
    expect(await call("rung_diagnostics", { path: "plc/PLC_1/blocks/Fx_Pump.scl" })).toEqual({ isError: true, text: "plc/PLC_1/blocks/Fx_Pump.scl is not a file of this workspace (rung_list lists the mirrored objects)" });
    expect((await call("rung_diff", { path: "plc\\PLC_1\\blocks\\Fx_Motor.scl" })).text).toBe("(no changes)");
  });

  it("name the path, address or object a mistyped one most likely meant", async () => {
    const { root } = await workspace();
    const call = await connect(root);
    const typo = "plc/PLC_1/blocks/Fx_Motr.scl";
    const meant = ": did you mean plc/PLC_1/blocks/Fx_Motor.scl?";
    expect((await call("rung_diagnostics", { path: typo })).text).toBe(`${typo} is not a file of this workspace${meant} (rung_list lists the mirrored objects)`);
    // the right file name in the wrong folder
    expect((await call("rung_diff", { path: "plc/PLC_1/blocks/Drives/Fx_Motor.scl" })).text).toBe(`plc/PLC_1/blocks/Drives/Fx_Motor.scl not found${meant}`);
    expect((await call("rung_compile", { addresses: [typo] })).text).toBe(`${typo} is not a mirrored object${meant} (rung_list lists them)`);
    expect((await call("rung_rename", { address: "plc:PLC_1/blocks/Fx_Mtor", newName: "Fx_Drive" })).text).toBe("plc:PLC_1/blocks/Fx_Mtor is not a mirrored object: did you mean plc:PLC_1/blocks/Fx_Motor? (rung_list lists them)");
    expect((await call("rung_resolve", { path: typo, mode: "theirs" })).text).toBe(`${typo} is not a mirrored file (rung_list with status conflicted lists the conflicts)`); // none in conflict: nothing to point at
    expect((await call("rung_confirm_delete", { address: typo })).isError).toBe(true);
    expect((await call("rung_explain", { name: "Fx_Motr" })).text).toBe("Fx_Motr is not in the workspace: did you mean Fx_Motor?");
    expect((await call("rung_find_usages", { name: "PLC_1/Fx_Mootor" })).text).toBe("PLC_1/Fx_Mootor is not in the workspace graph: did you mean PLC_1/Fx_Motor?");
  });

  it("check the files as they are right after an edit, and name the sources they checked", async () => {
    const { root } = await workspace();
    const call = await connect(root);
    const file = join(root, "plc", "PLC_1", "blocks", "Fx_Motor.scl");
    const before = JSON.parse((await call("rung_diagnostics", { path: "plc/PLC_1/blocks/Fx_Motor.scl" })).text);
    expect(before.source).toEqual([expect.objectContaining({ code: "UNDECLARED" })]);
    writeFileSync(file, MOTOR.replace("#nope := 1;", "")); // well inside any time window a cache might keep
    const after = JSON.parse((await call("rung_diagnostics", { path: "plc/PLC_1/blocks/Fx_Motor.scl" })).text);
    expect(after.source).toEqual([]);
    expect(after.sourceHash).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(JSON.parse((await call("rung_diagnostics")).text).sourceHash).toBe(after.sourceHash);
  });

  it("diagnostics give workspace paths as written, spaces and all", async () => {
    const { root } = await workspace();
    mkdirSync(join(root, "plc", "PLC_1", "tags"), { recursive: true });
    writeFileSync(join(root, "plc", "PLC_1", "tags", "Fx inputs.tags.st"), "VAR_GLOBAL\n    Start : Bool;\nEND_VAR\n");
    const d = JSON.parse((await (await connect(root))("rung_diagnostics")).text);
    expect(d.source).toContainEqual(expect.objectContaining({ path: "plc/PLC_1/tags/Fx inputs.tags.st", code: "NO_ADDRESS" }));
  });

  it("compile and confirm_delete take a workspace path as well as an address", async () => {
    const { root, config } = await workspace();
    const compiled: string[][] = [];
    const deleted: string[] = [];
    const bridgeFactory = async () =>
      Object.assign(new FakeBridge(), {
        close: async () => {},
        compile: async (_d: string, addresses: string[]) => (compiled.push(addresses), []),
        deleteObject: async (address: string) => (deleted.push(address), undefined),
      }) as never;
    const call = await connect(root, { bridgeFactory });
    expect((await call("rung_compile", { addresses: ["plc/PLC_1/blocks/Fx_Motor.scl"] })).isError).toBe(false);
    expect(compiled).toEqual([["plc:PLC_1/blocks/Fx_Motor"]]);
    // deleted in the workspace, then confirmed by its path
    unlinkSync(join(root, "plc", "PLC_1", "blocks", "Fx_Motor.scl"));
    const state = await StateStore.open(root, { projectPath: config.project.path, tiaVersion: "V20", devices: [] });
    state.upsert({ ...state.get("plc:PLC_1/blocks/Fx_Motor")!, status: "pendingDelete" });
    await state.close();
    expect(await call("rung_confirm_delete", { address: "plc/PLC_1/blocks/Fx_Motor.scl" })).toEqual({ isError: false, text: "deleted plc:PLC_1/blocks/Fx_Motor" });
    expect(deleted).toEqual(["plc:PLC_1/blocks/Fx_Motor"]);
  });

  it("list takes only the statuses it knows, and test says when a filter matches nothing", async () => {
    const { root } = await workspace();
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "motor.test.yaml"), "block: Fx_Motor\ncases:\n  - steps:\n      - cycle: 1\n");
    const call = await connect(root);
    expect((await call("rung_list", { status: "conflict" })).isError).toBe(true);
    expect(JSON.parse((await call("rung_list", { status: "synced" })).text).items).toEqual([expect.objectContaining({ path: "plc/PLC_1/blocks/Fx_Motor.scl" })]);
    expect(await call("rung_test", { filter: "valve" })).toEqual({ isError: false, text: 'No tests match "valve" (by file path, block name or case name); tests/**/*.test.yaml has 1 file.' });
  });

  it("live reads never send the password over plain http to a PLC on the network", async () => {
    const { root } = await workspace((c) => (c.live = { webapi: { url: "http://192.0.2.10", user: "Administrator" } }));
    const call = await connect(root, { env: { RUNG_WEBAPI_PASSWORD: "pw" } });
    expect(await call("rung_live_read", { names: ['"Fx_Global".Counter'] })).toEqual({
      isError: true,
      text: "http://192.0.2.10 is plain http: the password would travel unencrypted. Use https:// (set insecure = true for the PLC's self-signed certificate), or set RUNG_WEBAPI_ALLOW_HTTP=1 if you really mean it",
    });
  });
});

it("rung_test selects one case and strict fails cases that check nothing", async () => {
  const { root } = await workspace();
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "motor.test.yaml"), 'block: Fx_Motor\ncases:\n  - name: unchecked\n    steps: [{ set: { Start: true } }]\n  - name: checked\n    steps: [{ expect: { Start: false } }]\n');
  const call = await connect(root);
  const selected = JSON.parse((await call("rung_test", { case: "tests/motor.test.yaml#1", strict: true, verbose: true })).text);
  expect(selected).toMatchObject({ totalCases: 1, passed: 1, failed: 0, assertions: 1, items: [{ index: 1, name: "checked" }] });
  const unchecked = JSON.parse((await call("rung_test", { case: "tests/motor.test.yaml#0", strict: true })).text);
  expect(unchecked).toMatchObject({ totalCases: 1, passed: 0, failed: 1, failures: [{ name: "unchecked", error: expect.stringContaining("checks nothing") }] });
  expect(JSON.parse((await call("rung_test", { case: "tests/motor.test.yaml#0" })).text)).toMatchObject({ passed: 1, failed: 0 });
  for (const args of [{ case: "bad" }, { case: "tests/motor.test.yaml#9" }, { case: "../outside.test.yaml#0" }, { case: "tests/motor.test.yaml#1", filter: "checked" }]) {
    expect((await call("rung_test", args)).isError).toBe(true);
  }
});

it("handover keeps compile errors separate from import state and other PLCs", async () => {
  const { root } = await workspace();
  const call = await connect(root);
  const diagnostic = { code: "COMPILE", severity: "error", message: "broken in other PLC", path: "plc/Other/blocks/X.scl" };
  writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ items: [diagnostic] }));
  expect((await call("rung_download_request")).text).not.toContain("broken in other PLC");
  diagnostic.path = "plc/PLC_1/blocks/Fx_Motor.scl";
  diagnostic.message = "broken in selected PLC";
  writeFileSync(join(root, ".rung", "diagnostics.json"), JSON.stringify({ items: [diagnostic] }));
  const request = (await call("rung_download_request")).text;
  expect(request).toContain("TIA Portal has the files as they are");
  expect(request).toContain("1 compile error(s): do not download");
  expect(request).toContain("broken in selected PLC");
});
