// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WorkspaceIndex, uriOf, extractTwinCat, diagnostics, complete, definition, hover } from "../src/index.js";

const dir = fileURLToPath(new URL("./twincat/", import.meta.url));
const pump = () => uriOf(join(dir, "POUs", "FB_Pump.TcPOU"));
let idx: WorkspaceIndex;
const at = (needle: string, delta = 1) => idx.docs.get(pump())!.text.indexOf(needle) + delta;

beforeAll(async () => {
  idx = new WorkspaceIndex();
  await idx.load(dir); // no plc/ folder: TwinCAT/IEC mode
});

describe("TwinCAT sources", () => {
  it("blanks XML but keeps the code at its original offsets", () => {
    const xml = readFileSync(join(dir, "POUs", "FB_Pump.TcPOU"), "utf8");
    const u = extractTwinCat(xml);
    expect(u.code.length).toBe(xml.length);
    expect(u.name).toBe("FB_Pump");
    expect(u.code.indexOf("FUNCTION_BLOCK FB_Pump")).toBe(xml.indexOf("FUNCTION_BLOCK FB_Pump"));
    expect(u.code).not.toContain("<POU");
  });

  it("indexes POUs, methods, DUTs, GVLs and global variables", () => {
    const names = idx.allGlobals().map((g) => `${g.kind}:${g.name}`).sort();
    expect(names).toEqual(["FB:FB_Pump", "FC:Reset", "GVAR:bEStop", "GVAR:nCycles", "GVL:GVL_Plant", "UDT:ST_PumpCfg"]);
    const fb = idx.global("FB_Pump")!.block!;
    expect(fb.vars.map((v) => v.name)).toEqual(["bStart", "fSetpoint", "bRunning", "fFlow", "tonDelay", "stCfg"]);
  });

  it("reports only the genuinely unknown identifier", () => {
    const d = diagnostics(idx, pump()).map((x) => [x.code, idx.docs.get(pump())!.text.slice(x.start, x.end)]);
    expect(d).toEqual([["UNKNOWN_GLOBAL", "nUnknown"]]);
  });

  it("resolves members through DUTs, GVLs and standard FBs", () => {
    expect(definition(idx, pump(), at("fMaxFlow"))!.uri).toContain("ST_PumpCfg.TcDUT");
    expect(definition(idx, pump(), at("bEStop"))!.uri).toContain("GVL_Plant.TcGVL");
    expect(hover(idx, pump(), at("Q;", 0))!.markdown).toMatch(/\*\*Q\*\* : `Bool`/);
    expect(hover(idx, pump(), at("fSetpoint,"))!.markdown).toMatch(/l\/min/);
  });

  it("completes members of DUT-typed locals", () => {
    const text = idx.docs.get(pump())!.text.replace("nUnknown := 1;", "stCfg.");
    idx.set(pump(), text, 1);
    const labels = complete(idx, pump(), text.indexOf("stCfg.") + "stCfg.".length).map((c) => c.label);
    expect(labels).toEqual(["fMaxFlow", "nMode"]);
  });
});
