// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { discoveryHtml } from "../src/discoveryReport.js";
import type { DiscoveryEvidence } from "../src/discover.js";
import { Window } from "happy-dom";

const config = { block: "Motor", outputs: ["Running", "Count"], inputs: { Start: [false, true] }, cycle: "10ms", seed: 1, maxCycles: 8, maxEvents: 4, maxRuns: 4, timeoutMs: 1000, holds: [1] };
const base = { version: 1, runs: 2, searched: 2, stopped: "run-budget", reduced: false, reference: { commit: "a".repeat(40), sourceHash: "b" }, current: { sourceHash: "c" }, scope: "offline-simulator", assumptions: ["Not equivalence"] } as const;

async function render(e: DiscoveryEvidence) {
  const win = new Window({ settings: { disableJavaScriptEvaluation: false } });
  win.document.write(discoveryHtml(e));
  // document.write does not evaluate the inline program in happy-dom: run the shipped one explicitly
  win.eval(win.document.scripts[1]!.textContent!);
  await win.happyDOM.whenAsyncComplete();
  return win;
}

it("embeds hostile evidence as data, never executable markup, and says what not-found means", async () => {
  const e = { ...base, status: "not-found", config: { ...config, block: '</script><img src=x onerror="alert(1)">' } } satisfies DiscoveryEvidence;
  const html = discoveryHtml(e);
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("\\u003c/script>");
  expect(html).not.toMatch(/<script[^>]+src=/);
  const win = await render(e);
  try {
    expect(win.document.getElementById("block")?.textContent).toBe(e.config.block);
    expect(win.document.getElementById("story")?.textContent).toMatch(/does not prove/);
    expect((win.document.getElementById("save-test") as unknown as HTMLButtonElement).disabled).toBe(true);
  } finally { await win.happyDOM.close(); }
});

it("tells the witness as a story, shows each revision's writing line and follows the selected scan and signal", async () => {
  const text = 'FUNCTION_BLOCK "Motor"\n#Running := #Start OR #Running;\nEND_FUNCTION_BLOCK';
  const finding = { steps: [{ set: { Start: true }, cycles: 1 }, { set: { Start: false }, cycles: 1 }], before: [{ Running: true, Count: 1 }, { Running: true, Count: 2 }], after: [{ Running: true, Count: 1 }, { Running: false, Count: 3 }], difference: { cycle: 2, signal: "Running", before: true, after: false },
    cause: { before: { scan: 2, line: 2, value: true, because: [{ line: 2, reads: [{ name: "#Start", value: false }, { name: "#Running", value: true }] }] }, after: { scan: 2, line: 2, value: false, because: [{ line: 2, reads: [{ name: "#Start", value: false }, { name: "#Running", value: false }] }] } } };
  const count = { ...finding, difference: { cycle: 2, signal: "Count", before: 2, after: 3 }, cause: {} };
  const e = { ...base, status: "found", config, witness: finding, findings: [finding, count], changedLines: { before: [2], after: [2] }, alsoChanged: ["blocks/Valve.scl"],
    sources: { before: { file: "blocks/Motor.scl", text }, after: { file: "blocks/Motor.scl", text: text.replace(" OR #Running", "") } } } satisfies DiscoveryEvidence;
  const win = await render(e), $ = (id: string) => win.document.getElementById(id)!;
  try {
    expect($("also").textContent).toContain("Valve.scl");
    expect($("story").textContent).toBe("Start = TRUE for 1 scan, then Start = FALSE for 1 scan. At scan 2, Running is TRUE before your change and FALSE now.");
    expect($("cause").textContent).toContain("#Running := #Start OR #Running;");
    expect($("cause").textContent).toContain("Motor.scl:2 wrote FALSE at scan 2");
    expect($("after-source").querySelector(".ins.hit")?.textContent).toBe("#Running := #Start;");
    expect($("readout").textContent).toContain("before TRUE, now FALSE");
    $("chart").dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft" }) as unknown as Event);
    expect($("readout").textContent).toContain("scan 1");
    expect($("readout").textContent).toContain("before TRUE, now TRUE");
    const select = $("signal") as unknown as HTMLSelectElement;
    select.value = "Count"; select.dispatchEvent(new win.Event("change") as unknown as Event);
    expect($("lanes").textContent).toContain("Count before");
    expect($("readout").textContent).toContain("before 1, now 1");
    // two findings: tabs; the read that differs between the two revisions is marked
    expect($("status").textContent).toBe("2 differences");
    expect($("tabs").querySelectorAll("button")).toHaveLength(2);
    expect([...$("cause").querySelectorAll(".trail b.diff")].map(b => b.textContent)).toEqual(["TRUE", "FALSE"]);
    ($("tabs").querySelectorAll("button")[1] as unknown as HTMLButtonElement).click();
    expect($("story").textContent).toContain("Count is 2 before your change and 3 now");
    expect($("cause").textContent).toContain("No write to Count");
    ($("tabs").querySelectorAll("button")[0] as unknown as HTMLButtonElement).click();
    expect($("cause").querySelector(".trail")?.textContent).toBe("reading #Start = FALSE · #Running = TRUE");
    expect($("cause").querySelectorAll("ul.trail")).toHaveLength(0); // the write ran inside nothing
    expect($("cause").textContent).not.toContain("inside what line");
  } finally { await win.happyDOM.close(); }
});

it("says a call that read the same on both sides changed inside what it calls", async () => {
  const text = 'FUNCTION_BLOCK "Line"\n#v(Cmd := #Start, Out => #Open);\nEND_FUNCTION_BLOCK';
  const side = (value: boolean) => ({ scan: 1, line: 2, value, because: [{ line: 2, reads: [{ name: "#Start", value: true }] }] });
  const finding = { steps: [{ set: { Start: true }, cycles: 1 }], before: [{ Open: false }], after: [{ Open: true }], difference: { cycle: 1, signal: "Open", before: false, after: true }, cause: { before: side(false), after: side(true) } };
  const e = { ...base, status: "found", config: { ...config, block: "Line", outputs: ["Open"] }, witness: finding, findings: [finding], changedLines: { before: [], after: [] },
    sources: { before: { file: "blocks/Line.scl", text }, after: { file: "blocks/Line.scl", text } } } satisfies DiscoveryEvidence;
  const win = await render(e);
  try {
    expect(win.document.getElementById("cause")!.textContent).toContain("the difference comes from inside what line 2 calls");
  } finally { await win.happyDOM.close(); }
});
