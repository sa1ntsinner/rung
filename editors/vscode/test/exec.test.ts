// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { buildInvocation, findExecutable, quoteWindows } from "../src/core/exec";

const files = new Set(["C:\\bin\\rung.CMD", "C:\\node\\node.EXE", "/usr/bin/rung"]);
const win = { platform: "win32" as const, env: { Path: "C:\\bin;C:\\node", PATHEXT: ".EXE;.CMD" }, isFile: (p: string) => files.has(p) };

describe("quoteWindows", () => {
  it("quotes only when needed", () => {
    expect(quoteWindows("compile")).toBe("compile");
    expect(quoteWindows("C:\\a b\\x.scl")).toBe('"C:\\a b\\x.scl"');
    expect(quoteWindows('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindows("a&b")).toBe('"a&b"');
    expect(quoteWindows("")).toBe('""');
  });
});

describe("findExecutable", () => {
  it("uses PATH and PATHEXT on Windows", () => {
    expect(findExecutable("rung", win)).toBe("C:\\bin\\rung.CMD");
    expect(findExecutable("node", win)).toBe("C:\\node\\node.EXE");
    expect(findExecutable("missing", win)).toBeUndefined();
  });
  it("uses PATH on POSIX", () => {
    expect(findExecutable("rung", { platform: "linux", env: { PATH: "/usr/local/bin:/usr/bin" }, isFile: (p) => files.has(p) })).toBe("/usr/bin/rung");
  });
});

describe("buildInvocation", () => {
  it("wraps cmd shims in cmd.exe with one verbatim line", () => {
    const inv = buildInvocation(["rung"], ["compile", "--file", "plc/A B/x.scl"], { ...win, env: { ...win.env, ComSpec: "C:\\Windows\\cmd.exe" } });
    expect(inv.shell).toBe(true);
    expect(inv.file).toBe("C:\\Windows\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", '"C:\\bin\\rung.CMD compile --file "plc/A B/x.scl""']);
    expect(inv.display).toBe('rung compile --file "plc/A B/x.scl"');
  });
  it("spawns exe and node scripts directly", () => {
    const inv = buildInvocation(["node", "C:/rung/packages/cli/dist/index.js"], ["status"], win);
    expect(inv).toMatchObject({ file: "C:\\node\\node.EXE", args: ["C:/rung/packages/cli/dist/index.js", "status"], shell: false });
  });
  it("passes unknown commands through so the spawn error names them", () => {
    expect(buildInvocation([], ["status"], { platform: "linux", env: {}, isFile: () => false })).toMatchObject({ file: "rung", args: ["status"] });
  });
});
