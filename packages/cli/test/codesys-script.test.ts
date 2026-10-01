// SPDX-License-Identifier: BUSL-1.1
// The CODESYS bridge runs inside CODESYS (IronPython); its text functions are tested under CPython when there is one.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = (name: string) => fileURLToPath(new URL(`../../../bridge/codesys/${name}`, import.meta.url));
const python = ["python", "python3"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0);

describe.runIf(python)("CODESYS bridge script", () => {
  it("splits a POU file like CODESYS keeps it (python bridge/codesys/test_split.py)", () => {
    const r = spawnSync(python!, [script("test_split.py")], { encoding: "utf8" });
    expect(r.stderr).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  }, 60_000); // starts Python: slow on a busy Windows runner

  it("goes online by logging in only and reads without writing (python bridge/codesys/test_online.py)", () => {
    const r = spawnSync(python!, [script("test_online.py")], { encoding: "utf8" });
    expect(r.stderr).toMatch(/\nOK\s*$/);
    expect(r.status).toBe(0);
  }, 60_000); // starts Python: slow on a busy Windows runner
});
