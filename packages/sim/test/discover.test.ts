// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { discover, DiscoveryBudgetError, type DiscoveryStep } from "../src/discover.js";

const options = { inputs: { Start: [false, true] }, outputs: ["Running"], maxCycles: 8, maxEvents: 4, maxRuns: 120, holds: [1, 2, 4], seed: 17, timeoutMs: 5000 };
const execute = async (steps: DiscoveryStep[]) => {
  let latched = false;
  const before: Record<string, boolean>[] = [], after: Record<string, boolean>[] = [];
  for (const s of steps) for (let i = 0; i < s.cycles; i++) {
    latched ||= s.set.Start === true;
    before.push({ Running: latched }); after.push({ Running: s.set.Start === true });
  }
  return { before, after };
};

describe("behaviour discovery", () => {
  it("finds and reduces a stateful difference that no constant input reveals", async () => {
    const r = await discover(options, execute);
    expect(r.status).toBe("found");
    expect(r.witness?.steps).toEqual([{ set: { Start: true }, cycles: 1 }, { set: { Start: false }, cycles: 1 }]);
    expect(r.witness?.difference).toMatchObject({ cycle: 2, signal: "Running", before: true, after: false });
    expect(r.runs).toBeLessThanOrEqual(options.maxRuns);
  });
  it("is repeatable with the same seed and does not mutate options", async () => {
    const a = await discover(options, execute), b = await discover(options, execute);
    expect(a.witness).toEqual(b.witness);
    expect(a.runs).toBe(b.runs);
    expect(options.inputs.Start).toEqual([false, true]);
  });
  it("does not starve seeded exploration behind a truncated Cartesian prefix", async () => {
    const inputs = Object.fromEntries("ABCDEFGH".split("").map(n => [n, [false, true]]));
    const r = await discover({ ...options, inputs, maxCycles: 1, maxEvents: 1, maxRuns: 80, holds: [1] }, async steps => ({
      before: steps.map(() => ({ Running: false })),
      after: steps.map(s => ({ Running: !!s.set.A && !!s.set.B && !s.set.C })),
    }));
    expect(r.status).toBe("found");
  });
  it("observes the first differing scan even when final outputs agree", async () => {
    const r = await discover(options, async steps => {
      const n = steps.reduce((sum, s) => sum + s.cycles, 0);
      return { before: Array.from({ length: n }, () => ({ Running: false })), after: Array.from({ length: n }, (_, i) => ({ Running: i === 2 })) };
    });
    expect(r.witness?.difference.cycle).toBe(3);
    expect(r.witness?.steps.reduce((n, s) => n + s.cycles, 0)).toBe(3);
  });
  it("reports bounded not-found, never equivalence", async () => {
    const r = await discover({ ...options, maxRuns: 10 }, async steps => { const x = (await execute(steps)).before; return { before: x, after: x }; });
    expect(r.status).toBe("not-found"); expect(r.runs).toBeLessThanOrEqual(10); expect(r.witness).toBeUndefined();
  });
  it("refuses a missing observation rather than reporting equality", async () => {
    await expect(discover(options, async () => ({ before: [{}], after: [{}] }))).rejects.toThrow(/observation|frame/i);
  });
  it("propagates unsupported execution rather than labelling it a difference", async () => {
    await expect(discover(options, async () => { throw new Error("unsupported RDREC"); })).rejects.toThrow("unsupported RDREC");
  });
  it("stops an executor's scan-time deadline without calling it a program difference", async () => {
    const r = await discover(options, async () => { throw new DiscoveryBudgetError("scan deadline"); });
    expect(r.status).toBe("not-found"); expect(r.stopped).toBe("time-budget"); expect(r.runs).toBe(1);
  });
  it("retains a replayed witness when a reduction enters unsupported code", async () => {
    const r = await discover({ ...options, maxEvents: 1, inputs: { Start: [false] }, holds: [4] }, async steps => {
      const n = steps.reduce((a, s) => a + s.cycles, 0);
      if (n === 2) throw new Error("unsupported reduced path");
      return { before: Array.from({ length: n }, () => ({ Running: false })), after: Array.from({ length: n }, (_, i) => ({ Running: i >= 1 })) };
    });
    expect(r.status).toBe("found"); expect(r.witness?.difference.cycle).toBe(2);
    expect(r.reductionNotes).toContain("unsupported reduced path");
  });
  it("can merge adjacent events while reducing irrelevant input values", async () => {
    const r = await discover({ ...options, seed: 4, inputs: { Start: [false, true], Other: [false, true] }, maxCycles: 4, maxRuns: 500, holds: [1] }, async steps => {
      let count = 0; const before: Record<string, boolean>[] = [], after: Record<string, boolean>[] = [];
      for (const s of steps) for (let i = 0; i < s.cycles; i++) {
        count = s.set.Start ? count + 1 : 0; before.push({ Running: false }); after.push({ Running: count >= 3 });
      }
      return { before, after };
    });
    expect(r.status).toBe("found"); expect(r.witness?.difference.cycle).toBe(3);
  });
  it.each([1, 2, 3, 5, 8, 13])("does not shrink a witness into a different output's difference (seed %i)", async seed => {
    // Running differs on a falling edge after Start was held 2 scans; Alarm differs at scan 1 of any
    // 3-scan run that starts with Start: shrinking a longer Running witness lands on Alarm runs.
    let first: string | undefined;
    const r = await discover({ ...options, seed, outputs: ["Running", "Alarm"], maxRuns: 400 }, async steps => {
      const x = steps.flatMap(s => Array.from({ length: s.cycles }, () => s.set.Start === true));
      const before = x.map(() => ({ Running: false, Alarm: false }));
      const after = x.map((v, i) => ({ Running: i >= 2 && !v && x[i - 1]! && x[i - 2]!, Alarm: i === 0 && v && x.length === 3 }));
      const at = after.findIndex(f => f.Running || f.Alarm);
      if (!first && at >= 0) first = after[at]!.Alarm ? "Alarm" : "Running";
      return { before, after };
    });
    expect(r.status).toBe("found");
    expect(r.witness?.difference.signal).toBe(first);
  });
  it.each([true, false])("walks a sequencer step by step from the states it reached (guided: %s)", async guided => {
    // step n advances when input n alone is TRUE; any other input resets it: random vectors rarely get far
    const names = ["A", "B", "C", "D"], o = { ...options, inputs: Object.fromEntries(names.map(n => [n, [false, true]])), outputs: ["Done"], maxCycles: 16, maxEvents: 8, maxRuns: 400 };
    const r = await discover(o, async steps => {
      let step = 0; const before: Record<string, boolean>[] = [], after: Record<string, boolean>[] = [], reached = new Set<string>();
      for (const s of steps) for (let i = 0; i < s.cycles; i++) {
        const on = names.filter(n => s.set[n] === true);
        step = on.length === 1 && on[0] === names[step] ? step + 1 : on.length === 1 && step > 0 && on[0] === names[step - 1] ? step : on.length ? 0 : step;
        reached.add(`step=${step}`);
        before.push({ Done: false }); after.push({ Done: step === 4 });
      }
      return { before, after, ...(guided ? { reached: [...reached] } : {}) };
    });
    expect(r.status).toBe(guided ? "found" : "not-found");
  });
  it("keeps looking after a finding and reduces each distinct one on its own", async () => {
    // Running differs whenever Start is TRUE; Alarm only after Stop was held 2 scans; Running FALSE>TRUE differs too
    const o = { ...options, inputs: { Start: [false, true], Stop: [false, true] }, outputs: ["Running", "Alarm"], maxRuns: 600 };
    const r = await discover(o, async steps => {
      const before: Record<string, boolean>[] = [], after: Record<string, boolean>[] = [];
      let held = 0;
      for (const s of steps) for (let i = 0; i < s.cycles; i++) {
        held = s.set.Stop ? held + 1 : 0;
        before.push({ Running: false, Alarm: false }); after.push({ Running: s.set.Start === true, Alarm: held >= 2 });
      }
      return { before, after };
    });
    expect(r.findings?.map(f => f.difference.signal).sort()).toEqual(["Alarm", "Running"]);
    const alarm = r.findings!.find(f => f.difference.signal === "Alarm")!;
    expect(alarm.steps).toEqual([{ set: { Start: false, Stop: true }, cycles: 2 }]);
    expect(r.witness).toEqual(r.findings![0]);
  });
  it("tries every simple sequence before giving up on more findings", async () => {
    // Running differs as soon as A is TRUE; Alarm only when Z, the last input, is held 5 scans: its simple
    // sequence comes after more than 200 others
    const names = [..."ABCDEFGHIJKLM", "Z"], o = { ...options, inputs: Object.fromEntries(names.map(n => [n, [false, true]])), outputs: ["Running", "Alarm"], maxCycles: 16, holds: Array.from({ length: 16 }, (_, i) => i + 1), maxRuns: 3000, timeoutMs: 30000 };
    const r = await discover(o, async steps => {
      const before: Record<string, boolean>[] = [], after: Record<string, boolean>[] = [];
      let held = 0;
      for (const s of steps) for (let i = 0; i < s.cycles; i++) {
        held = s.set.Z && !names.slice(0, -1).some(n => s.set[n]) ? held + 1 : 0;
        before.push({ Running: false, Alarm: false }); after.push({ Running: s.set.A === true, Alarm: held >= 5 });
      }
      return { before, after };
    });
    expect(r.findings?.map(f => f.difference.signal).sort()).toEqual(["Alarm", "Running"]);
  });
  it("tells a Boolean's two directions apart and never reports one finding twice", async () => {
    const o = { ...options, maxRuns: 400 };
    const r = await discover(o, async steps => {
      const x = steps.flatMap(s => Array.from({ length: s.cycles }, () => s.set.Start === true));
      return { before: x.map(v => ({ Running: v })), after: x.map((v, i) => ({ Running: i === 0 ? !v : v })) };
    });
    expect(r.findings?.map(f => `${f.difference.before}>${f.difference.after}`).sort()).toEqual(["false>true", "true>false"]);
    const once = await discover(o, execute);
    expect(once.findings).toHaveLength(1);
  });
  it("replays seeds that fit the domains first, skips the rest, and hands back what reached new states", async () => {
    const seed = [{ set: { Start: true }, cycles: 1 }, { set: { Start: false }, cycles: 1 }];
    const r = await discover({ ...options, findings: 1, seeds: [[{ set: { Start: 3 }, cycles: 1 }], [{ set: { Other: true }, cycles: 1 }], seed] }, async steps => ({ ...(await execute(steps)), reached: [JSON.stringify(steps)] }));
    expect(r.reused).toBe(1);
    expect(r.searched).toBe(1);
    expect(r.corpus[0]).toEqual(seed);
  });
  it.each([{ maxCycles: 0 }, { maxRuns: Infinity }, { seed: NaN }, { holds: [0] }, { inputs: {} }, { outputs: [] }, { inputs: { Start: [NaN] } }])("refuses invalid search bounds %j", async patch => {
    await expect(discover({ ...options, ...patch }, execute)).rejects.toThrow();
  });
});
