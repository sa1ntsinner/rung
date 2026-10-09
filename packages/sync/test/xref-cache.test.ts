// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedXref } from "../src/xref-cache.js";

describe("cross-reference cache", () => {
  it("keeps TIA Portal's answer until a mirrored object changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-xref-"));
    mkdirSync(join(root, ".rung"));
    const state = (fp: string) => writeFileSync(join(root, ".rung", "state.json"), JSON.stringify({ objects: { a: { address: "plc:P/blocks/A", tiaFingerprint: fp } } }));
    state("fp:1");
    let asked = 0;
    const ask = async () => [{ source: "A", sourceName: "A", targetName: `Main${++asked}`, targetType: "OB", access: "Call", referenceType: "UsedBy" }];
    expect((await cachedXref(root, "plc:P/blocks/A", ask, { now: () => 5 })).at).toBeUndefined();
    const kept = await cachedXref(root, "plc:P/blocks/A", ask);
    expect([kept.at, kept.entries[0]!.targetName, asked]).toEqual([5, "Main1", 1]);
    state("fp:2"); // changed in TIA Portal since: asked again
    expect((await cachedXref(root, "plc:P/blocks/A", ask)).entries[0]!.targetName).toBe("Main2");
    expect((await cachedXref(root, "plc:P/blocks/A", ask, { fresh: true })).entries[0]!.targetName).toBe("Main3");
  });

  it("asks again after the workspace is bound to another project, whatever its objects look like", async () => {
    const root = mkdtempSync(join(tmpdir(), "rung-xref-"));
    mkdirSync(join(root, ".rung"));
    const state = (project: string) => writeFileSync(join(root, ".rung", "state.json"), JSON.stringify({ binding: { projectPath: project }, objects: { a: { address: "plc:P/blocks/A", tiaFingerprint: "fp:1" } } }));
    let asked = 0;
    const ask = async () => [{ source: "A", sourceName: "A", targetName: `Screen${++asked}`, targetType: "HMI screen", access: "Read", referenceType: "UsedBy" }];
    state("C:\\one.ap20");
    await cachedXref(root, "plc:P/blocks/A", ask);
    state("C:\\two.ap20");
    expect((await cachedXref(root, "plc:P/blocks/A", ask)).entries[0]!.targetName).toBe("Screen2");
  });
});
