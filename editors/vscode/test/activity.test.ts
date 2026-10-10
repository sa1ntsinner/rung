// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { Activity, STUCK_MS, objectName, statusPhrase } from "../src/core/activity";

const report = (o: Partial<Record<string, unknown>> = {}) => ({
  exported: 0, imported: 0, created: 0, merged: 0, unchanged: 10, conflicts: 0, removed: 0, pendingDeletes: 0, warnings: [], diagnostics: [], ...o,
});
const on = { watching: true, writes: "on" as const, conflicts: 0 };
const err = (path: string, code: string, message = "x", line?: number) => ({ address: `PLC_1/${objectName(path)}`, path, severity: "error", code, message, ...(line ? { line } : {}) });

describe("the save loop as the editor shows it", () => {
  it("names the PLC once the workspace has shown more than one", () => {
    const a = new Activity(() => 0);
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_A.scl", action: "import" }] }));
    expect(a.entries[0]!.label).toBe("FB_A sent to TIA");
    a.event("report", report({ imported: 2, changes: [{ path: "plc/PLC_1/blocks/FB_A.scl", action: "import" }, { path: "plc/Line%2F2/blocks/FB_A.scl", action: "import" }] }));
    expect(a.entries.slice(0, 2).map((e) => e.label)).toEqual(["PLC_1 · FB_A sent to TIA", "Line/2 · FB_A sent to TIA"]);
  });

  it("a save goes out, compiles and lands: one phrase per moment, and one line of history", () => {
    let now = 1000;
    const a = new Activity(() => now);
    a.event("phase", { phase: "sending", detail: "plc/PLC_1/blocks/FB_Batch.scl" });
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · FB_Batch → TIA");
    now = 1800;
    a.event("phase", { phase: "compiling", detail: "what uses the changed blocks" });
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · compiling in TIA");
    now = 2500;
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_Batch.scl", action: "import" }], compiled: ["PLC_1/FB_Batch"] }));
    expect(statusPhrase(a, on, now).text).toMatch(/^\$\(check\) rung · sent to TIA \d\d:\d\d$/);
    expect(a.entries[0]).toMatchObject({ path: "plc/PLC_1/blocks/FB_Batch.scl", kind: "import", ms: 1500, errors: 0, label: "FB_Batch sent to TIA · compiled" });
  });

  it("says while TIA Portal starts, in the background or with its window, and never takes the wait for a stuck dialog", () => {
    let now = 0;
    const a = new Activity(() => now);
    a.event("connected", {});
    a.event("phase", { phase: "starting-tia", detail: "background" });
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · starting TIA Portal");
    now = 60_000; // a cold start takes long: still starting, not "a dialog may be open"
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · starting TIA Portal");
    a.event("phase", { phase: "starting-tia", detail: "window" });
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · opening a TIA Portal window");
    a.event("phase", { phase: "tia-started" });
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · connecting to TIA Portal");
  });
  it("a refusal only a person can lift says what is needed, not that rung waits for TIA Portal", () => {
    const a = new Activity(() => 0);
    a.event("connected", {});
    a.event("error", { message: "Openness registration is missing", code: "ACCESS_DENIED", blocked: true });
    expect(statusPhrase(a, on, 0)).toMatchObject({ text: "$(shield) rung · Openness access needed", tone: "warning" });
    expect(statusPhrase(a, on, 10 * 60_000).text).toBe("$(shield) rung · Openness access needed"); // never "a dialog may be open"
    a.event("report", report());
    expect(statusPhrase(a, on, 0).text).toBe("$(check) rung · in sync");
  });
  it("compile errors, refusals, conflicts and writes off outrank a quiet state", () => {
    const a = new Activity(() => 0);
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_A.scl", action: "import" }], diagnostics: [err("plc/PLC_1/blocks/FB_A.scl", "COMPILE", "x", 12), err("plc/PLC_1/blocks/FB_A.scl", "COMPILE"), { ...err("plc/PLC_1/blocks/FB_A.scl", "COMPILE"), severity: "warning" }] }));
    expect(statusPhrase(a, on, 0)).toMatchObject({ text: "$(error) rung · 2 compile errors", tone: "error" });
    expect(a.entries[0]).toMatchObject({ label: "FB_A sent to TIA · 2 compile errors", line: 12 });
    expect(statusPhrase(a, { ...on, conflicts: 1 }, 0)).toMatchObject({ text: "$(warning) rung · 1 conflict", tone: "warning" });
    const b = new Activity(() => 0);
    expect(statusPhrase(b, { ...on, writes: "off" }, 0).text).toBe("$(lock) rung · writes off");
    expect(statusPhrase(b, { ...on, writes: "manual" }, 0).text).toBe("$(lock) rung · manual sync");
    expect(statusPhrase(b, { ...on, watching: false }, 0).text).toBe("$(circle-slash) rung · watch off");
    expect(statusPhrase(b, { ...on, watching: false, conflicts: 2 }, 0).text).toBe("$(warning) rung · 2 conflicts · watch off");
    expect(statusPhrase(b, on, 0).text).toBe("$(check) rung · in sync");
  });

  it("a compile error stands through quiet passes until a pass compiles that object again", () => {
    const a = new Activity(() => 0);
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_A.scl", action: "import" }], diagnostics: [err("plc/PLC_1/blocks/FB_A.scl", "COMPILE", "x", 21)] }));
    a.event("report", report({ unchanged: 108 }));
    expect(statusPhrase(a, on, 0)).toMatchObject({ text: "$(error) rung · 1 compile error", tone: "error" });
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_A.scl", action: "import" }], compiled: ["PLC_1/FB_A"] }));
    expect(statusPhrase(a, on, 0).text).toMatch(/^\$\(check\) rung · sent to TIA/);
  });

  it("a save that is not sent says so once, and the bar keeps saying it until it goes", () => {
    const a = new Activity(() => 0);
    const refused = err("plc/PLC_1/blocks/FB_X.scl", "DEPENDENCY_BLOCKED", "Waiting for PLC_1/UDT_A, which could not be imported");
    a.event("report", report({ diagnostics: [refused] }));
    expect(a.entries.map((e) => e.label)).toEqual(["FB_X not sent: Waiting for PLC_1/UDT_A, which could not be imported"]);
    expect(statusPhrase(a, on, 0)).toMatchObject({ text: "$(error) rung · 1 not sent", tone: "error" });
    a.event("report", report({ diagnostics: [refused] }));
    expect(a.entries).toHaveLength(1);
    a.event("report", report({ imported: 1, changes: [{ path: "plc/PLC_1/blocks/FB_X.scl", action: "import" }] }));
    expect(statusPhrase(a, on, 0).text).toMatch(/sent to TIA/);
  });

  it("TIA's changes coming back and merges are history in the order they happened; quiet passes are not", () => {
    const a = new Activity(() => 0);
    a.event("report", report());
    expect(a.entries).toHaveLength(0);
    a.event("report", report({ exported: 1, merged: 1, changes: [{ path: "plc/PLC_1/blocks/Main.scl", action: "export" }, { path: "plc/PLC_1/blocks/FB_B.scl", action: "merge" }] }));
    expect(a.entries.map((e) => e.label)).toEqual(["Main updated from TIA", "FB_B merged with TIA's change"]);
    expect(a.entries[0]!.ms).toBeUndefined();
  });

  it("a whole project mirrored at once is one line", () => {
    const a = new Activity(() => 0);
    a.event("report", report({ exported: 30, changes: Array.from({ length: 30 }, (_, i) => ({ path: `plc/PLC_1/blocks/FB_${i}.scl`, action: "export" })) }));
    expect(a.entries.map((e) => e.label)).toEqual(["30 objects updated from TIA"]);
  });

  it("a lost TIA Portal: waiting, outranking old compile errors; the retries are one counted line", () => {
    const a = new Activity(() => 0);
    a.event("report", report({ diagnostics: [err("plc/PLC_1/blocks/FB_A.scl", "COMPILE")] }));
    for (let i = 0; i < 5; i++) a.event("error", { message: "TIA Portal is not running", retryInMs: 4000 });
    expect(a.entries.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(a.entries[0]).toMatchObject({ label: "TIA Portal is not running", count: 5 });
    expect(statusPhrase(a, on, 0)).toMatchObject({ text: "$(debug-disconnect) rung · waiting for TIA Portal", tone: "warning" });
    a.event("report", report()); // back, with the compile error still standing
    expect(statusPhrase(a, on, 0).text).toBe("$(error) rung · 1 compile error");
  });

  it("connecting until the watch has a pass; a pass that hangs points at a dialog", () => {
    let now = 0;
    const a = new Activity(() => now);
    a.reset();
    expect(statusPhrase(a, on, now).text).toBe("$(sync~spin) rung · connecting to TIA Portal");
    a.event("status", { owner: { lastPassAt: 5, lastError: null } });
    expect(statusPhrase(a, on, now).text).toBe("$(check) rung · in sync");
    a.reset();
    a.event("status", { owner: { lastPassAt: 0, lastError: "TIA_NOT_RUNNING: TIA Portal is not running" } });
    expect(statusPhrase(a, on, now).text).toBe("$(debug-disconnect) rung · waiting for TIA Portal");
    a.event("phase", { phase: "sending", detail: "plc/PLC_1/blocks/FB_A.scl" });
    now += STUCK_MS + 1;
    expect(statusPhrase(a, on, now)).toMatchObject({ text: "$(watch) rung · waiting for TIA Portal (a dialog may be open)", tone: "warning" });
  });

  it("names objects without their folders and file kinds; keeps the last 200 lines", () => {
    expect(objectName("plc/PLC_1/types/UDT_Recipe.udt.xml")).toBe("UDT_Recipe");
    expect(objectName("plc\\PLC_1\\blocks\\FB_A.scl")).toBe("FB_A");
    const a = new Activity(() => 0);
    for (let i = 0; i < 250; i++) a.event("report", report({ imported: 1, changes: [{ path: `plc/PLC_1/blocks/FB_${i}.scl`, action: "import" }] }));
    expect(a.entries).toHaveLength(200);
    expect(a.entries[0]!.path).toBe("plc/PLC_1/blocks/FB_249.scl");
  });
});
