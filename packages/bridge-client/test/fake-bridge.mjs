// SPDX-License-Identifier: MIT
// Minimal stand-in for rung-bridge speaking the JSON-lines protocol. Behaviour via FAKE_MODE.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const objects = [
  { address: "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", kind: "block", language: "SCL", blockType: "FB", knowHowProtected: false, isFailsafe: false, isSystem: false, fingerprint: "fp:Code=1" },
];

if (mode === "hang-hello") setInterval(() => {}, 1000);

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  const reply = (result) => out({ id: req.id, result });
  const fail = (code, message) => out({ id: req.id, error: { code, message } });
  if (mode === "hang-hello") return;
  switch (req.method) {
    case "bridge.hello":
      reply({ protocol: mode === "protocol2" ? 2 : 1, tiaVersion: "V20", bridgeVersion: "fake", capabilities: ["export"] });
      if (mode === "crash-after-hello") setTimeout(() => process.exit(3), 20);
      // like a bridge stuck while TIA Portal opens a project: it ignores the end of its input, its child runs on
      if (mode === "stuck-with-child") {
        const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        process.stderr.write(`child ${c.pid}\n`);
        setInterval(() => {}, 1000);
      }
      // like a bridge whose TIA Portal outlives it: a child that inherited the pipes keeps them open
      if (mode === "orphan-after-hello") {
        spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit" });
        setTimeout(() => process.exit(3), 20);
      }
      return;
    case "project.info":
      return fail("TIA_NOT_RUNNING", "no portal");
    case "objects.list":
      if (mode === "slow") return;
      if (mode === "garbage-line") process.stdout.write("Siemens says hello\n");
      if (mode === "event") out({ event: "log", params: { level: "info", message: "listing" } });
      if (mode === "unicode") return reply([{ ...objects[0], address: "plc:PLC_1/blocks/Überwachung 😀" }]);
      return reply(objects);
    case "objects.import":
      if (mode === "write-no-response") return;
      return reply({ address: req.params.address, form: req.params.form, files: [], warnings: [], fingerprint: "fp:Code=2", bundleHash: "x" });
    case "echo.env":
      return reply({ fake: process.env.FAKE_MODE, path: process.env.PATH ? "set" : "missing" });
    default:
      return fail("BAD_REQUEST", "unknown " + req.method);
  }
});
