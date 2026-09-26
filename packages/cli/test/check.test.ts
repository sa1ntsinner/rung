// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { formatChecks, runChecks, type Probes, type WindowsInventory } from "@rung/core";

function probes(o: Partial<Probes> & { inv?: Partial<WindowsInventory>; on?: string[] } = {}): Probes {
  const inv: WindowsInventory = { installed: [], opennessApis: [], inOpennessGroup: false, twincatDir: null, codesys: [], ...o.inv };
  return {
    platform: "win32",
    nodeVersion: "v24.1.0",
    home: "C:\\Users\\me",
    exists: () => false,
    which: (c) => ((o.on ?? []).includes(c) ? `C:\\bin\\${c}.exe` : null),
    windows: async () => inv,
    vscodeExtensions: async () => [],
    zedExtensions: () => null,
    bridgeWhitelisted: async () => "missing",
    ...o,
  };
}
const byId = async (p: Probes) => Object.fromEntries((await runChecks(p)).map((i) => [i.id, i]));

describe("rung check", () => {
  it("on a bare Windows PC says what to install for each platform, with links", async () => {
    const r = await byId(probes());
    expect(r.tia).toMatchObject({ status: "missing", link: expect.stringContaining("siemens.com") });
    expect(r.twincat).toMatchObject({ status: "missing", fix: expect.stringMatching(/TE1000/) });
    expect(r.codesys).toMatchObject({ status: "missing", link: expect.stringContaining("codesys") });
    expect(r.git).toMatchObject({ status: "missing" });
    expect(r["openness-group"]).toBeUndefined(); // only asked about when TIA is there
  });

  it("with TIA Portal installed checks Openness, the group and the whitelist", async () => {
    const r = await byId(
      probes({
        inv: { installed: [{ name: "Siemens Totally Integrated Automation Portal V20 - STEP 7 Single SetupPackage  V20.0", version: "20.00.0000" }, { name: "SIMATIC S7-PLCSIM V20", version: "S7-PLCSIM V20" }], opennessApis: ["V20"], inOpennessGroup: false },
        bridgeWhitelisted: async () => "stale",
      }),
    );
    expect(r.tia).toMatchObject({ status: "ok", detail: "V20" });
    expect(r.openness).toMatchObject({ status: "ok" });
    expect(r["openness-group"]).toMatchObject({ status: "missing", fix: expect.stringMatching(/net localgroup/) });
    expect(r.whitelist).toMatchObject({ status: "missing", fix: "rung setup openness", detail: expect.stringMatching(/changed/) });
    expect(r.plcsim).toMatchObject({ status: "ok", detail: "V20" });
  });

  it("finds editors, rung extensions and agents", async () => {
    const r = await byId(probes({ on: ["code", "claude", "git"], vscodeExtensions: async () => ["sa1ntsinner.rung-scl"], exists: (p) => p.endsWith(".codex") }));
    expect(r.vscode).toMatchObject({ status: "ok", detail: "rung extension installed" });
    expect(r.claude).toMatchObject({ status: "ok" });
    expect(r.codex).toMatchObject({ status: "ok", detail: expect.stringContaining(".codex") });
    expect(r.cursor).toMatchObject({ status: "missing" });
  });

  it("on Linux explains that TIA Portal needs Windows instead of claiming it is missing", async () => {
    const r = await byId(probes({ platform: "linux" }));
    expect(r.tia).toMatchObject({ status: "na", fix: expect.stringMatching(/Windows only/) });
    expect(r.twincat).toBeUndefined();
  });

  it("prints fixes only for what is not ok", async () => {
    const text = formatChecks(await runChecks(probes({ on: ["git"] })), false);
    expect(text).toMatch(/✓ Git/);
    expect(text).toMatch(/· TIA Portal \(STEP 7\)\n.*\n\s+→ Install TIA Portal/);
    expect(text).not.toMatch(/✓ Git\n\s+→/);
  });
});
