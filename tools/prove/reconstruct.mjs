// SPDX-License-Identifier: MIT
// Offline acceptance of plcsim-run.ps1 captureBefore results; never connects to a PLC.
// node tools/prove/reconstruct.mjs <workspace> <relative FB.scl> <DB> <raw.json>
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceIndex, deviceOfUri, scopedTo } from "../../packages/lsp/dist/index.js";
import { Simulator, reconstructCycle, reconstructionRevision } from "../../packages/sim/dist/index.js";

const [workspace, relative, db, raw, captureDirectory] = process.argv.slice(2);
if (!workspace || !relative || !db || !raw) throw new Error("Usage: reconstruct.mjs <workspace> <relative FB.scl> <DB> <raw.json> [capture-directory]");
if (statSync(raw).size > 1_048_576) throw new Error("Capture size limit exceeded");
const index = new WorkspaceIndex(); await index.load(resolve(workspace));
const uri = pathToFileURL(resolve(workspace, relative)).href;
const block = index.docs.get(uri)?.parsed?.blocks[0];
if (!block || block.kind !== "FB") throw new Error("Choose an exported fixture FB");
if (index.global(db, uri)?.block?.dbOf?.toUpperCase() !== block.name.toUpperCase()) throw new Error("Selected DB does not belong to this FB");
// Fixture exports are trusted inputs; product capture validation runs in reconstructCycle.
const template = new Simulator(scopedTo(index, uri)).newInstance(block.name).mem;
function memory(shape, flat, path = "") {
  if (shape && typeof shape === "object") {
    if ("std" in shape || "stub" in shape || "__ptr" in shape) throw new Error(`${path}: opaque instance state is unsupported`);
    if (shape.__fb) return { __fb: shape.__fb, mem: memory(shape.mem, flat, path) };
    if (shape.__array) return { __array: true, lo: shape.lo, items: shape.items.map((v, i) => memory(v, flat, `${path}[${shape.lo + i}]`)) };
    return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, memory(value, flat, path ? `${path}.${key}` : key)]));
  }
  if (!Object.hasOwn(flat, path)) throw new Error(`${path}: missing captured value`);
  return flat[path];
}
const rows = JSON.parse(readFileSync(raw, "utf8"));
if (rows.capture?.instance !== "RungProve" || rows.capture?.db !== db || rows.capture?.controller !== "PLC_1") throw new Error("Capture fixture/DB provenance is missing or changed");
let cycles = 0, differences = 0;
for (const test of rows.cases) for (const step of test.steps) {
  if (step.cycles !== 1) throw new Error("Reconstruction requires exactly one captured cycle per step");
  const upper = values => Object.fromEntries(Object.entries(values).map(([name, value]) => [name.toUpperCase(), value]));
  const scope = { plc: deviceOfUri(uri), instance: `"${db}"`, epoch: 1 };
  const capture = { scope, sourceRevision: reconstructionRevision(index, uri), time: 0, clockStart: 0,
    coherence: "controlled-cycle", before: { mem: memory(template, upper(step.before)), globals: {} }, observed: memory(template, upper(step.values)) };
  const result = reconstructCycle(index, uri, capture, scope);
  differences += result.divergences.length; cycles++;
  if (captureDirectory) {
    mkdirSync(captureDirectory, { recursive: true });
    writeFileSync(resolve(captureDirectory, `cycle-${cycles}.json`), JSON.stringify(capture), { flag: "wx" });
  }
  console.log(JSON.stringify({ case: test.name, step: step.step, members: Object.keys(step.before).length,
    entries: result.trace.length, exact: result.exact, divergences: result.divergences }));
}
if (!cycles) throw new Error("Capture has no cycles");
process.exitCode = differences ? 2 : 0;
