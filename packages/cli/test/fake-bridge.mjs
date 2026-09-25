// SPDX-License-Identifier: BUSL-1.1
// Process-level fake of rung-bridge for CLI tests. Objects come from FAKE_OBJECTS (JSON file path).
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);
const projectArg = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : null;
const db = JSON.parse(readFileSync(process.env.FAKE_OBJECTS, "utf8"));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  const reply = (result) => out({ id: req.id, result });
  const fail = (code, message) => out({ id: req.id, error: { code, message } });
  const p = req.params ?? {};
  if (req.method !== "bridge.hello" && process.env.FAKE_ACCESS_DENIED) return fail("ACCESS_DENIED", "not in group Siemens TIA Openness");
  if (req.method !== "bridge.hello" && projectArg && projectArg.toLowerCase() !== db.project.path.toLowerCase())
    return fail("NO_PROJECT", "Project is not open in any TIA Portal instance: " + projectArg);
  switch (req.method) {
    case "bridge.hello":
      return reply({ protocol: 1, tiaVersion: "V20", bridgeVersion: "fake", capabilities: argv.includes("--allow-fixture-import") ? ["import"] : [] });
    case "project.info":
      return reply(db.project);
    case "objects.list":
      return reply(db.objects.filter((o) => o.address.startsWith(`plc:${p.device}/`)).map((o) => o.entry ?? { address: o.address, kind: "block", language: "SCL", knowHowProtected: false, isFailsafe: false, isSystem: false, fingerprint: "fp:" + sha(o.content).slice(0, 8) }));
    case "objects.export": {
      const o = db.objects.find((x) => x.address === p.address);
      if (!o) return fail("NOT_FOUND", p.address);
      const path = join(p.dir, "obj.scl");
      writeFileSync(path, o.content);
      const files = [{ path, role: "primary", sha256: sha(o.content) }];
      return reply({ address: p.address, form: "scl", files, warnings: [], fingerprint: "fp:" + sha(o.content).slice(0, 8), bundleHash: "x" });
    }
    case "objects.import":
      if (!argv.includes("--allow-fixture-import")) return fail("READ_ONLY", "imports need --allow-fixture-import on a fixture project");
      return reply({ address: p.address, form: p.form, files: [], warnings: [], fingerprint: "fp:x", bundleHash: "x" });
    default:
      return fail("BAD_REQUEST", "unknown " + req.method);
  }
});
