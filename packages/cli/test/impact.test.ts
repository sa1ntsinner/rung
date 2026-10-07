// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { main } from "../src/main.js";

const VALVE = (inputs: string) => `FUNCTION_BLOCK "Fb_Valve"\nVAR_INPUT\n${inputs}\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n`;

describe("rung impact", () => {
  it("compares a block's interface with the version TIA Portal has and names what breaks", async () => {
    const ws = mkdtempSync(join(tmpdir(), "rung-impact-"));
    const blocks = join(ws, "plc", "PLC_1", "blocks");
    mkdirSync(blocks, { recursive: true });
    mkdirSync(join(ws, "tests"));
    writeFileSync(join(ws, "rung.toml"), "");
    const before = VALVE("  open : Bool;\n  speed : Int;");
    const hash = createHash("sha256").update(before).digest("hex");
    mkdirSync(join(ws, ".rung", "base", hash.slice(0, 2)), { recursive: true });
    writeFileSync(join(ws, ".rung", "base", hash.slice(0, 2), hash), before);
    const path = "plc/PLC_1/blocks/Fb_Valve.scl";
    writeFileSync(join(ws, ".rung", "state.json"), JSON.stringify({ objects: { a: { address: "PLC_1/Fb_Valve", path, files: [{ path, role: "primary", hash }] } } }));
    writeFileSync(join(blocks, "Fb_Valve.scl"), VALVE("  open : Bool;"));
    writeFileSync(join(blocks, "Main.scl"), 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  "Valve_DB"(open := TRUE, speed := 2);\nEND_ORGANIZATION_BLOCK\n');
    writeFileSync(join(blocks, "Valve_DB.db"), 'DATA_BLOCK "Valve_DB"\n"Fb_Valve"\nBEGIN\nEND_DATA_BLOCK\n');
    writeFileSync(join(ws, "tests", "valve.test.yaml"), "block: Fb_Valve\ncases:\n  - steps:\n      - set: { speed: 1 }\n");
    const out: string[] = [];
    const io = { cwd: ws, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: {} };
    expect(await main(["impact", path], io)).toBe(2);
    const text = out.join("");
    expect(text).toContain("Fb_Valve (FB): the interface changed against the version TIA Portal has");
    expect(text).toContain("- input speed : Int  removed");
    expect(text).toContain("plc/PLC_1/blocks/Main.scl:3  Main: passes speed, which Fb_Valve no longer has");
    expect(text).toMatch(/start values on download[^\n]*\n  Valve_DB  plc\/PLC_1\/blocks\/Valve_DB\.db/);
    expect(text).toContain("tests/valve.test.yaml: case 1 sets speed, which Fb_Valve no longer has");
    // as TIA Portal has it: nothing to tell
    writeFileSync(join(blocks, "Fb_Valve.scl"), before);
    out.length = 0;
    expect(await main(["impact", path], io)).toBe(0);
    expect(out.join("")).toContain("the interface is the one TIA Portal has");
    out.length = 0;
    writeFileSync(join(blocks, "New.scl"), 'FUNCTION "New" : Void\nBEGIN\nEND_FUNCTION\n');
    expect(await main(["impact", "plc/PLC_1/blocks/New.scl"], io)).toBe(1);
    expect(out.join("")).toContain("never synced");
  });
});
