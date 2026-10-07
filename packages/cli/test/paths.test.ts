// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRoot, tiaOf, tiaOfProject } from "../src/paths.js";

describe("installRoot", () => {
  it("is the folder of rung.cjs, also when npm starts it through a link named rung", (ctx) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rung-paths-")));
    const pkg = join(dir, "lib", "node_modules", "@rung-plc", "cli");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(pkg, "rung.cjs"), "");
    expect(installRoot({}, join(pkg, "rung.cjs"))).toBe(pkg);
    try {
      symlinkSync(join(pkg, "rung.cjs"), join(dir, "bin", "rung"));
    } catch {
      return ctx.skip(); // Windows without the right to make links: npm makes rung.cmd there, which runs rung.cjs by its path
    }
    expect(installRoot({}, join(dir, "bin", "rung"))).toBe(pkg);
  });

  it("is none for a script that is not rung's, and RUNG_HOME wins", () => {
    expect(installRoot({}, join(tmpdir(), "vitest.mjs"))).toBeUndefined();
    expect(installRoot({ RUNG_HOME: "/opt/rung" }, "/whatever/rung.cjs")).toBe("/opt/rung");
  });
});

describe("TIA Portal versions", () => {
  it("come from the project file's extension, and V20 is the default", () => {
    expect([tiaOfProject("D:/P/Line.ap19"), tiaOfProject("Line.AP21"), tiaOfProject("x.ap20"), tiaOfProject("x.project")]).toEqual(["V19", "V21", "V20", undefined]);
    expect([tiaOf("V19"), tiaOf("V21"), tiaOf("CODESYS"), tiaOf(undefined)]).toEqual(["V19", "V21", "V20", "V20"]);
  });
});