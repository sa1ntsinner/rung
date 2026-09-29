// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

describe("IEC workspaces", () => {
  const FB = `FUNCTION_BLOCK FB_Axis
VAR_INPUT
  bEnable : BOOL;
END_VAR
VAR
  bLatch : BOOL;
  bIn AT %I* : BOOL;
  bOut AT %Q* : BOOL;
  pVal : POINTER TO INT;
  rVal : REFERENCE TO INT;
  aLocal : ARRAY[0..cMax] OF INT;
  aGlob : ARRAY[1..GVL_Cfg.MAX] OF INT;
END_VAR
VAR CONSTANT
  cMax : INT := 3;
END_VAR
(* outer (* nested *) still a comment *)
bLatch S= bEnable;
bLatch R= NOT bEnable;
bOut := bIn AND pVal^ > 0 AND rVal > 0;
aLocal[1] := GVL_Cfg.aItems[1];
nUnknown := 1;
END_FUNCTION_BLOCK

METHOD M_Reset : BOOL
VAR_INPUT
  bHard : BOOL;
END_VAR
bLatch := FALSE;
aLocal[0] := 0;
M_Reset := bHard;
END_METHOD
`;
  const GVL = "VAR_GLOBAL CONSTANT\n  MAX : INT := 4;\nEND_VAR\nVAR_GLOBAL\n  aItems : ARRAY[1..MAX] OF INT;\nEND_VAR\n";

  async function loadDir(layout: Record<string, string>): Promise<WorkspaceIndex> {
    const root = mkdtempSync(join(tmpdir(), "rung-iec-"));
    for (const [rel, text] of Object.entries(layout)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const w = new WorkspaceIndex();
    await w.load(root);
    return w;
  }

  it("uses IEC mode when a PLC/plc folder is not a rung layout", async () => {
    for (const dir of ["PLC", "plc"]) {
      const w = await loadDir({ [`${dir}/Project/FB_Axis.st`]: FB, [`${dir}/Project/GVL_Cfg.st`]: GVL, "IM/Vci.db": "SQLite format 3\u0000\u0010garbage" });
      expect([...w.docs.keys()].some((k) => k.endsWith("Vci.db")), "binary TIA project files are skipped").toBe(false);
      expect(w.allGlobals().map((g) => `${g.kind}:${g.name}`).sort(), dir).toEqual(["FB:FB_Axis", "FC:M_Reset", "GVAR:MAX", "GVAR:aItems", "GVL:GVL_Cfg"]);
    }
    const rung = await loadDir({ "rung.toml": "", "plc/PLC_1/blocks/B.scl": 'FUNCTION "B" : Void\nBEGIN\nEND_FUNCTION\n', "plc/x.st": FB });
    expect(rung.allGlobals().map((g) => g.name)).toEqual(["B"]);
  });

  it("reports only the genuinely unknown identifier (nested comments, S=/R=, AT %I*, pointers, constant bounds, methods)", async () => {
    const w = await loadDir({ "src/FB_Axis.st": FB, "src/GVL_Cfg.st": GVL });
    const fb = [...w.docs.keys()].find((k) => k.endsWith("FB_Axis.st"))!;
    const d = diagnostics(w, fb).map((x) => [x.code, w.docs.get(fb)!.text.slice(x.start, x.end)]);
    expect(d).toEqual([["UNKNOWN_GLOBAL", "nUnknown"]]);
  });
});
