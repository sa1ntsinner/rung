// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceIndex, uriOf, diagnostics, definition, references, hover, complete, rename, outline } from "../src/index.js";

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
      "Fx_Global".Counter := "Fx_Global".Counter + 1;
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
    const refs = references(idx, user(), at(user(), '"Fx_Global".Counter'));
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
    expect(rename(idx, user(), at(user(), '"Fx_Global"'), "X")).toMatchObject({ error: expect.stringMatching(/Only local/) });
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
