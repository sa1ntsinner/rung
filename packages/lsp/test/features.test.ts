// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toYaml } from "@rung/core";
import { VIEW_HEADER, toView } from "@rung/sync";
import { WorkspaceIndex, uriOf, diagnostics, definition, references, hover, complete, rename, outline, nearest } from "../src/index.js";

const fixtures = fileURLToPath(new URL("../../../tools/fixtures/scl/", import.meta.url));
let root: string;
let idx: WorkspaceIndex;
const at = (uri: string, needle: string, delta = 1) => idx.docs.get(uri)!.text.indexOf(needle) + delta;

const TAGS = `<?xml version="1.0" encoding="utf-8"?>
<Document><SW.Tags.PlcTagTable ID="0"><AttributeList><Name>Fx_Inputs</Name></AttributeList><ObjectList>
<SW.Tags.PlcTag ID="1" CompositionName="Tags"><AttributeList><DataTypeName>Bool</DataTypeName><LogicalAddress>%I0.0</LogicalAddress><Name>Start_Button</Name></AttributeList></SW.Tags.PlcTag>
</ObjectList></SW.Tags.PlcTagTable></Document>
`;

const USER = `FUNCTION_BLOCK "Fx_User"
VAR
   Motor : "Fx_Motor";
   Timer {InstructionName := 'TON_TIME'} : TON_TIME;
   Cfg : "Fx_Types";
END_VAR
VAR_TEMP
   speed : Real;
END_VAR
BEGIN
   #Motor(Start := "Start_Button", Stop := FALSE, SpeedSetpoint := "Fx_Global".Station.Setpoint);
   #speed := #Motor.SpeedOut;
   #Timer(IN := #Motor.Running, PT := T#2s);
   IF #Timer.Q AND #Cfg.Enabled THEN
      "Fx_Global".Count := "Fx_Global".Count + 1;
   END_IF;
   #nope := 1;
   #Cfg.Missing := TRUE;
   "Unknown_DB".x := 1;
END_FUNCTION_BLOCK
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rung-lsp-"));
  const blocks = join(root, "plc", "PLC_1", "blocks");
  mkdirSync(join(blocks, "10_Drives", "Motors"), { recursive: true });
  mkdirSync(join(root, "plc", "PLC_1", "types"), { recursive: true });
  mkdirSync(join(root, "plc", "PLC_1", "tags"), { recursive: true });
  copyFileSync(join(fixtures, "Fx_Motor.scl"), join(blocks, "10_Drives", "Motors", "Fx_Motor.scl"));
  copyFileSync(join(fixtures, "Fx_Global.db"), join(blocks, "Fx_Global.db"));
  copyFileSync(join(fixtures, "Fx_Types.udt"), join(root, "plc", "PLC_1", "types", "Fx_Types.udt"));
  writeFileSync(join(blocks, "Fx_User.scl"), USER);
  writeFileSync(join(blocks, "Fx_Lad.s7dcl"), "lad\n");
  writeFileSync(join(root, "plc", "PLC_1", "tags", "Fx_Inputs.tags.xml"), TAGS);
  idx = new WorkspaceIndex();
  await idx.load(root);
  void readdirSync;
});

const user = () => uriOf(join(root, "plc", "PLC_1", "blocks", "Fx_User.scl"));
const motor = () => uriOf(join(root, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl"));
const types = () => uriOf(join(root, "plc", "PLC_1", "types", "Fx_Types.udt"));

describe("workspace features", () => {
  it("indexes blocks, UDTs, DBs, tags and graphical objects", () => {
    const names = idx.allGlobals().map((g) => `${g.kind}:${g.name}`).sort();
    expect(names).toEqual(["DB:Fx_Global", "FB:Fx_Motor", "FB:Fx_User", "OBJECT:Fx_Lad", "TAG:Start_Button", "UDT:Fx_Types"]);
  });

  it("reports undeclared locals, unknown members and unknown globals, nothing else", () => {
    const d = diagnostics(idx, user()).map((x) => [x.code, idx.docs.get(user())!.text.slice(x.start, x.end)]);
    expect(d).toEqual([
      ["UNDECLARED", "#nope"],
      ["UNKNOWN_MEMBER", "Missing"],
      ["UNKNOWN_GLOBAL", '"Unknown_DB"'],
    ]);
  });

  it("goes to local declarations, globals in other files and UDT members through a DB", () => {
    expect(definition(idx, user(), at(user(), "#speed :="))).toMatchObject({ uri: user(), start: at(user(), "speed : Real", 0) });
    expect(definition(idx, user(), at(user(), '"Fx_Global".Station'))!.uri).toContain("Fx_Global.db");
    const setpoint = definition(idx, user(), at(user(), "Setpoint);", 2))!;
    expect(setpoint.uri).toBe(types());
    expect(idx.docs.get(types())!.text.slice(setpoint.start, setpoint.end)).toBe("Setpoint");
    const speedOut = definition(idx, user(), at(user(), "SpeedOut;", 2))!;
    expect(speedOut.uri).toBe(motor());
  });

  it("resolves members of standard function blocks (TON_TIME.Q)", () => {
    expect(hover(idx, user(), at(user(), "Q AND", 0))!.markdown).toMatch(/\*\*Q\*\* : `Bool`/);
  });

  it("hovers show types, comments, tags and standard function signatures", () => {
    expect(hover(idx, user(), at(user(), '"Start_Button"'))!.markdown).toMatch(/PLC tag \*\*Start_Button\*\* : `Bool` at `%I0.0`/);
    expect(hover(idx, motor(), idx.docs.get(motor())!.text.indexOf("LIMIT") + 1)!.markdown).toMatch(/LIMIT\*\*\(MN/);
    expect(hover(idx, motor(), idx.docs.get(motor())!.text.indexOf("#SpeedSetpoint,") + 2)!.markdown).toMatch(/rpm/);
  });

  it("finds references of a global across files", () => {
    const refs = references(idx, user(), at(user(), '"Fx_Global".Count'));
    expect(refs.filter((r) => r.uri === user())).toHaveLength(3);
    expect(refs.some((r) => r.uri.endsWith("Fx_Global.db"))).toBe(true);
  });

  it("completes locals, members, globals and types by context", () => {
    const labels = (text: string) => {
      const doc = idx.set(user(), USER.replace("#nope := 1;", text), 1);
      const r = complete(idx, user(), doc.text.indexOf(text) + text.length).map((c) => c.label);
      idx.set(user(), USER, 2);
      return r;
    };
    expect(labels("#sp")).toEqual(expect.arrayContaining(["speed", "Motor", "Timer"]));
    expect(labels("#Motor.")).toEqual(["Start", "Stop", "SpeedSetpoint", "Running", "SpeedOut", "Latch"]);
    expect(labels('"Fx_Global".Station.')).toEqual(["Enabled", "Mode", "Setpoint", "Label"]);
    expect(labels("#Timer.")).toEqual(["IN", "PT", "Q", "ET"]);
    expect(labels('"Fx_')).toEqual(expect.arrayContaining(["Fx_Global", "Fx_Motor", "Start_Button"]));
  });

  it("renames a local everywhere in its block and refuses globals", () => {
    const edits = rename(idx, user(), at(user(), "#speed :="), "velocity");
    expect(Array.isArray(edits) && edits.map((e) => e.newText)).toEqual(["velocity", "#velocity"]);
    expect(rename(idx, user(), at(user(), '"Fx_Global"'), "X")).toMatchObject({ error: expect.stringMatching(/Only variables/) });
    expect(rename(idx, user(), at(user(), "#speed :="), "Motor")).toMatchObject({ error: expect.stringMatching(/already exists/) });
    expect(rename(idx, user(), at(user(), "#speed :="), "1bad")).toMatchObject({ error: expect.stringMatching(/not a valid/) });
  });

  it("outlines blocks with sections and variables", () => {
    const o = outline(idx, user())[0]!;
    expect(o.name).toBe("Fx_User");
    expect(o.children.map((c) => c.name)).toEqual(["VAR", "VAR_TEMP"]);
  });

  it("answers completion in well under 100 ms on a 500-block workspace", async () => {
    const big = new WorkspaceIndex();
    for (let i = 0; i < 500; i++) big.set(`file:///w/plc/P/blocks/B${i}.scl`, USER.replace(/Fx_User/g, `B${i}`), 0);
    big.set("file:///w/probe.scl", USER, 0);
    const offset = USER.indexOf("#speed :=") + 3;
    big.global("B1"); // build the global table once
    const times: number[] = [];
    for (let k = 0; k < 50; k++) {
      const t0 = performance.now();
      complete(big, "file:///w/probe.scl", offset);
      definition(big, "file:///w/probe.scl", USER.indexOf('"Fx_Global"') + 1);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(100);
  });
});

describe("QA regressions", () => {
  const FB = `FUNCTION_BLOCK "Q_Fb"
VAR
   T1 {InstructionName := 'TON_TIME'} : TON_TIME;
   n : Int;
   st : "Q_Stat";
   tmr : IEC_TIMER;
   cnt : IEC_COUNTER;
   r : REF_TO Int;
END_VAR
BEGIN
   #T1(IN := TRUE, PT := T#1s);
   IF #st.lastSync.YEAR = 2200 OR #st.lastSync.MONTH = 1 THEN
      #st.localIP.ADDR[1] := 192;
   END_IF;
   #st.lastSync.NOPE := 1;
   #tmr.TON(IN := TRUE, PT := T#1s);
   #cnt.CTU(CU := #tmr.Q, PV := 3);
   #n := "Q_Start".Mode + "Q_Struct".Limits.MaxCurrent;
   "Q_Struct".Limits.Nope := 1;
END_FUNCTION_BLOCK
`;
  const UDT = 'TYPE "Q_Stat"\nVERSION : 0.1\n   STRUCT\n      lastSync : DTL;\n      localIP : IP_V4;\n      other : "Not_Mirrored";\n   END_STRUCT;\nEND_TYPE\n';
  const INST = 'DATA_BLOCK "Q_Inst"\n{ S7_Optimized_Access := \'TRUE\' }\nVERSION : 0.1\nNON_RETAIN\n"Q_Fb"\n\nBEGIN\n   T1.PT := T#2s;\n   n := 5;\n   T1.XX := 1;\nEND_DATA_BLOCK\n';
  const START = 'DATA_BLOCK "Q_Start"\nVERSION : 0.1\n   VAR\n      Plug : Struct\n         Delay_time : S5Time;\n      END_STRUCT;\n      Mode : Byte;\n   END_VAR\nBEGIN\n   Mode := 16#2;\n   Plug.Delay_time := S5T#1s;\nEND_DATA_BLOCK\n';
  const STRUCT_DB = 'DATA_BLOCK "Q_Struct"\n{ S7_Optimized_Access := \'FALSE\' }\nVERSION : 0.1\nNON_RETAIN\n   STRUCT\n      Limits : Struct\n         MaxCurrent : Int;\n      END_STRUCT;\n      Flag : Bool;\n   END_STRUCT;\nBEGIN\n   Flag := TRUE;\nEND_DATA_BLOCK\n';
  const STL = 'FUNCTION "Q_Stl" : Void\nVERSION : 0.1\nVAR_INPUT\n  a : Bool;\nEND_VAR\nBEGIN\nNETWORK\nTITLE = t\n      A(;\n      A "Q_Start".Mode;\n      );\n      L s5t#10ms;\n      = #a;\nEND_FUNCTION\n';
  const u = (n: string) => `file:///q/plc/P/blocks/${n}`;
  const q = new WorkspaceIndex();
  q.set(u("Q_Fb.scl"), FB, 0);
  q.set("file:///q/plc/P/types/Q_Stat.udt", UDT, 0);
  q.set(u("Q_Inst.db"), INST, 0);
  q.set(u("Q_Start.db"), START, 0);
  q.set(u("Q_Struct.db"), STRUCT_DB, 0);
  q.set(u("Q_Stl.awl"), STL, 0);
  const diag = (n: string) => diagnostics(q, u(n)).map((d) => [d.code, q.docs.get(u(n))!.text.slice(d.start, d.end)]);

  it("accepts DB start values of own members and of instance DBs", () => {
    expect(diag("Q_Start.db")).toEqual([]);
    expect(diag("Q_Inst.db")).toEqual([["UNKNOWN_MEMBER", "XX"]]);
    const off = INST.indexOf("PT :=");
    expect(hover(q, u("Q_Inst.db"), off)!.markdown).toMatch(/\*\*PT\*\* : `Time`/);
  });

  it("resolves system-type members on UDT members, IEC_TIMER calls and REF_TO", () => {
    expect(diag("Q_Fb.scl")).toEqual([
      ["UNKNOWN_MEMBER", "NOPE"],
      ["UNKNOWN_MEMBER", "Nope"],
    ]);
    expect(hover(q, u("Q_Fb.scl"), FB.indexOf("YEAR") + 1)!.markdown).toMatch(/\*\*YEAR\*\* : `UInt`/);
  });

  it("indexes standard-access DB members and ignores STL bodies", () => {
    expect(diag("Q_Struct.db")).toEqual([]);
    expect(diag("Q_Stl.awl")).toEqual([]);
    expect(q.global("Q_Stl")!.block!.vars.map((v) => v.name)).toEqual(["a"]);
    const def = definition(q, u("Q_Fb.scl"), FB.indexOf("MaxCurrent") + 1)!;
    expect(q.docs.get(def.uri)!.text.slice(def.start, def.end)).toBe("MaxCurrent");
  });

  it("finds references of DB and UDT members", () => {
    const refs = references(q, u("Q_Fb.scl"), FB.indexOf("MaxCurrent") + 1);
    expect(refs.map((r) => [r.uri.split("/").pop(), q.docs.get(r.uri)!.text.slice(r.start, r.end)])).toEqual([
      ["Q_Struct.db", "MaxCurrent"],
      ["Q_Fb.scl", "MaxCurrent"],
    ]);
    const plug = references(q, u("Q_Start.db"), START.indexOf("Mode :=") + 1, false);
    expect(plug.map((r) => r.uri.split("/").pop())).toEqual(["Q_Fb.scl", "Q_Start.db"]);
    const year = references(q, "file:///q/plc/P/types/Q_Stat.udt", UDT.indexOf("lastSync") + 1, false);
    expect(year.map((r) => q.docs.get(r.uri)!.text.slice(r.start, r.end))).toEqual(["lastSync", "lastSync", "lastSync"]);
  });
});

describe("nearest", () => {
  it("finds the name a typo meant: two letters off at most, one for short names, any letter case", () => {
    expect(nearest("Strat", ["Stop", "Start"])).toBe("Start");
    expect(nearest("FX_MOTR", ["Fx_Motor"])).toBe("Fx_Motor");
    expect(nearest("ab", ["xy", "abc"])).toBe("abc");
    expect(nearest("ab", ["xy"])).toBeUndefined();
    expect(nearest("Throttle", ["Start", "Stop"])).toBeUndefined();
  });
});

describe("names of a real project that no mirrored file declares", () => {
  type Node = Parameters<typeof toView>[0];
  const node = (type: string, name: string, attributes: Record<string, string> = {}, children: Record<string, Node[]> = {}): Node => ({ type, name, attributes, children });

  it("knows the technology objects of `rung views`, each PLC its own", async () => {
    const ws = mkdtempSync(join(tmpdir(), "rung-lsp-to-"));
    const src = 'FUNCTION "Fx_Count" : DInt\nBEGIN\n\t#Fx_Count := "Fx_Lift".Position;\n\t"Fx Axis".Enable := TRUE;\nEND_FUNCTION\n';
    for (const plc of ["PLC_A", "PLC_B"]) {
      mkdirSync(join(ws, "plc", plc, "blocks"), { recursive: true });
      writeFileSync(join(ws, "plc", plc, "blocks", "Fx_Count.scl"), src);
    }
    const axes = node("TechnologicalInstanceDBUserGroup", "Drives", {}, { TechnologicalObjects: [node("TechnologicalInstanceDB", "Fx Axis", { InstanceOfName: "TO_SpeedAxis", Number: "7" })] });
    const plcA = node("TechnologicalInstanceDBGroup", "PLC_A", {}, { TechnologicalObjects: [node("TechnologicalInstanceDB", "Fx_Lift", { InstanceOfName: "TO_PositioningAxis", Number: "5" })], Groups: [axes] });
    mkdirSync(join(ws, "views", "techobjects"), { recursive: true });
    writeFileSync(join(ws, "views", "techobjects", "PLC_A.yaml"), toYaml(toView(plcA), VIEW_HEADER));
    writeFileSync(join(ws, "views", "techobjects", "PLC_B.yaml"), toYaml(toView(node("TechnologicalInstanceDBGroup", "PLC_B")), VIEW_HEADER));
    const w = new WorkspaceIndex();
    await w.load(ws);
    const a = uriOf(join(ws, "plc", "PLC_A", "blocks", "Fx_Count.scl"));
    const b = uriOf(join(ws, "plc", "PLC_B", "blocks", "Fx_Count.scl"));
    expect(diagnostics(w, a)).toEqual([]);
    expect(hover(w, a, src.indexOf('"Fx_Lift"') + 1)?.markdown).toBe("Technology object **Fx_Lift** : `TO_PositioningAxis` (DB 5)");
    const def = definition(w, a, src.indexOf('"Fx Axis"') + 1)!;
    expect(w.docs.get(def.uri)!.text.slice(def.start, def.end)).toBe("Fx Axis");
    // PLC_B has none: the names stay unknown there, and its empty view is no object of its own
    expect(diagnostics(w, b).map((d) => d.code)).toEqual(["UNKNOWN_GLOBAL", "UNKNOWN_GLOBAL"]);
    expect(w.global("PLC_B")).toBeUndefined();
  });

  it("reads a DB's start values of quoted members as the DB's own", () => {
    const db = 'DATA_BLOCK "Fx_Valves"\nVERSION : 0.1\n   VAR\n      "Valve 1" : Struct\n         "Open, delay" : Time;\n      END_STRUCT;\n   END_VAR\nBEGIN\n   "Valve 1"."Open, delay" := T#2s;\nEND_DATA_BLOCK\n';
    const w = new WorkspaceIndex();
    const uri = "file:///w/plc/P/blocks/Fx_Valves.db";
    w.set(uri, db, 0);
    const use = db.lastIndexOf('"Valve 1"') + 1;
    expect(diagnostics(w, uri)).toEqual([]);
    expect(hover(w, uri, use)?.markdown).toMatch(/\*\*Valve 1\*\* : `Struct`/);
    expect(hover(w, uri, db.lastIndexOf('"Open, delay"') + 1)?.markdown).toMatch(/\*\*Open, delay\*\* : `Time`/);
    expect(definition(w, uri, use)?.start).toBe(db.indexOf('"Valve 1"'));
  });

  it("gives no verdict on the start values of an instance DB whose FB is not in the workspace", () => {
    const db = 'DATA_BLOCK "Fx_Pump_Inst"\nVERSION : 0.1\nNON_RETAIN\n"Lib_Pump"\n\nBEGIN\n   "Start delay" := T#2s;\n   Speed := 1.0;\nEND_DATA_BLOCK\n';
    const w = new WorkspaceIndex();
    const uri = "file:///w/plc/P/blocks/Fx_Pump_Inst.db";
    w.set(uri, db, 0);
    expect(diagnostics(w, uri)).toEqual([]);
  });

  it("knows an FC's return value by the FC's name", () => {
    const udt = 'TYPE "Fx_Motor_Data"\nVERSION : 0.1\n   STRUCT\n      Speed : Real;\n   END_STRUCT;\nEND_TYPE\n';
    const scale = 'FUNCTION "Fx_Scale" : Real\nVAR_INPUT\n   raw : Int;\nEND_VAR\nBEGIN\n   #Fx_Scale := INT_TO_REAL(#raw) / 10.0;\nEND_FUNCTION\n';
    const make = 'FUNCTION "Fx_Make" : "Fx_Motor_Data"\nBEGIN\n   #Fx_Make.Speed := 1.0;\n   #Fx_Make.Nope := 2.0;\nEND_FUNCTION\n';
    const w = new WorkspaceIndex();
    const u = (n: string) => `file:///w/plc/P/blocks/${n}`;
    w.set("file:///w/plc/P/types/Fx_Motor_Data.udt", udt, 0);
    w.set(u("Fx_Scale.scl"), scale, 0);
    w.set(u("Fx_Make.scl"), make, 0);
    const at = scale.indexOf("#Fx_Scale") + 1;
    expect(hover(w, u("Fx_Scale.scl"), at)?.markdown).toBe("Return value **Fx_Scale** : `Real`");
    const g = w.global("Fx_Scale")!;
    expect(definition(w, u("Fx_Scale.scl"), at)).toEqual({ uri: u("Fx_Scale.scl"), start: g.start, end: g.end });
    expect(hover(w, u("Fx_Make.scl"), make.indexOf("Speed") + 1)?.markdown).toMatch(/\*\*Speed\*\* : `Real`/);
    expect(diagnostics(w, u("Fx_Make.scl")).map((d) => [d.code, make.slice(d.start, d.end)])).toEqual([["UNKNOWN_MEMBER", "Nope"]]);
  });

  it("says what a hardware identifier is", () => {
    const src = 'FUNCTION "Fx_Io" : Void\nVAR_TEMP\n   id : HW_IO;\nEND_VAR\nBEGIN\n   #id := "Rack_1~Valve_Module";\nEND_FUNCTION\n';
    const w = new WorkspaceIndex();
    const uri = "file:///w/plc/P/blocks/Fx_Io.scl";
    w.set(uri, src, 0);
    expect(diagnostics(w, uri)).toEqual([]);
    expect(hover(w, uri, src.indexOf("Rack_1") + 1)?.markdown).toBe("Hardware identifier **Rack_1~Valve_Module** (a system constant of the device configuration)");
  });
});
