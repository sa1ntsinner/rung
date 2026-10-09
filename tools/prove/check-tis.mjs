// SPDX-License-Identifier: MIT
// Offline assertion of the recorded TIA fixture transaction; performs no PLC IO.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync(new URL("captures/tis-proveops.json", import.meta.url), "utf8"));
assert.equal(evidence.fixture, "RungProve");
assert.equal(evidence.job.attributes["2691"], "False");
assert.equal(evidence.watchPoints.length, 43);
assert.equal(evidence.watchPoints.reduce((n, p) => n + p.values.length, 0), 50);
assert.equal(evidence.watchPoints.flatMap(p => p.values).filter(v => v.reference).length, 46);
assert.deepEqual(evidence.observations.map(x => [x.inputs.a, x.inputs.b]).sort(), [[0, 0], [5, 0], [5, 2]]);
const bySac = new Map(evidence.watchPoints.map(p => [p.sac, p]));
for (const observation of evidence.observations) {
  const raw = Buffer.from(observation.result, "hex");
  assert.equal(raw.length, evidence.resultBytes);
  for (const p of evidence.watchPoints) {
    assert(p.offset >= 0 && p.offset + 4 <= raw.length);
    for (const v of p.values) {
      assert(v.offset >= 0 && v.offset + v.bytes <= raw.length);
      assert(v.validity >= 0 && v.validity < raw.length);
      for (const source of v.source ?? []) assert(Number.isInteger(source.line) && source.line > 0);
    }
  }
  const value = sac => raw.readInt16BE(bySac.get(sac).values[0].offset);
  const { a, b } = observation.inputs;
  assert.equal(value(12), a + b); assert.equal(value(24), a - b); assert.equal(value(36), a * b);
  assert.equal(raw.readUInt32BE(bySac.get(46).offset) !== 0, b !== 0);
  const quotient = bySac.get(58).values[0];
  assert.equal(raw[quotient.validity], b ? 15 : 0);
  if (b) assert.equal(value(58), 2);
}
console.log("Actual TIA fixture: 43 points, 50 values, three branch states agree; invalid untaken value preserved.");
for (const [file, count] of [["tis-prepost.json", 3], ["tis-generated-prepost.json", 5]]) {
const snapshots = JSON.parse(readFileSync(new URL(`captures/${file}`, import.meta.url), "utf8"));
assert.equal(snapshots.job.attributes["2691"], "False");
assert.equal(snapshots.layout.length, 70);
assert.equal(snapshots.observations.length, count);
if (snapshots.generatedHeaderAndTrigger) {
  const trigger = Buffer.from(snapshots.job.attributes["2694"], "hex");
  assert.equal(trigger.length, 24);
  assert.equal(trigger.subarray(16).toString("base64"), snapshots.codeModifiedTimestamp);
  assert.equal(trigger.subarray(0, 5).toString("hex"), "1006000001");
  assert.equal(Buffer.from(snapshots.job.attributes["2693"], "hex").subarray(0, 10).toString("hex"), "4101c8320624440a4814");
}
for (const sample of snapshots.observations) {
  const raw = Buffer.from(sample.result, "hex");
  assert.equal(raw.length, snapshots.resultBytes);
  if (snapshots.caller) {
    const caller = snapshots.caller;
    assert.equal(raw.readUInt16BE(caller.stackOffset), caller.number);
    assert.equal(raw[caller.frameOffset], 1); // Recorded native StackList decoder: OB.
    assert.equal(raw.readUInt16BE(caller.frameOffset + 2), caller.number);
    assert.equal(raw.readUInt32BE(caller.frameOffset + 4), caller.sac);
    assert(caller.operandXml.includes(`sac="${caller.sac}"`));
    assert(caller.operandXml.includes(`elementId="${caller.elementId}"`));
    assert(caller.callXml.includes(`UId="${caller.elementId}"`));
    assert(caller.callXml.includes(`ODN="&quot;${caller.instance}&quot;"`));
  }
  for (const phase of ["before", "after"]) {
    const layout = snapshots.layout.filter(v => v.phase === phase);
    assert.equal(new Set(layout.map(v => v.name)).size, 35);
    assert.equal(Object.keys(sample[phase]).length, 35);
    for (const v of layout) {
      assert(v.offset >= 0 && v.offset + v.bytes <= raw.length && v.validity >= 0 && v.validity < raw.length);
      assert.equal(raw[v.validity], 15);
      const value = v.type.endsWith("Bool}") ? raw[v.offset] !== 0 : v.type.endsWith("Real}") ? raw.readFloatBE(v.offset)
        : /(?:Int|DInt)\}$/.test(v.type) ? raw.readIntBE(v.offset, v.bytes) : raw.readUIntBE(v.offset, v.bytes);
      assert.equal(value, sample[phase][v.name]);
    }
  }
}
console.log(`${file}: 35 members per phase, 70 valid values in each of ${count} recorded samples.`);
}
