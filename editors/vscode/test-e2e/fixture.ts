// SPDX-License-Identifier: MIT
// Builds the fake-backend workspace for the integration tests: `rung init` + `rung pull` against
// packages/cli/test/fake-bridge.mjs, then one conflict (edited here and "in TIA Portal").
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeWorkspace {
  dir: string;
  objects: string;
  env: Record<string, string>;
}

const fb = (name: string, extra = "") => `FUNCTION_BLOCK "${name}"
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
   VAR_INPUT
      start : Bool;
      speed : Int;
   END_VAR
   VAR_OUTPUT
      running : Bool;
   END_VAR

BEGIN
	#running := #start;${extra}
END_FUNCTION_BLOCK
`;

export const FAKE_PROJECT = "C:\\fx\\RungE2E\\RungE2E.ap20";

export function rungCli(repo: string, cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(repo, "packages", "cli", "dist", "index.js"), ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

function writeObjects(objects: string): void {
  writeFileSync(
    objects,
    JSON.stringify({
      project: { name: "RungE2E", path: FAKE_PROJECT, tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false },
      objects: [
        { address: "plc:PLC_1/blocks/Main", content: 'ORGANIZATION_BLOCK "Main"\nVERSION : 0.1\nBEGIN\n\t"Fx_Pump_DB"(start := TRUE);\nEND_ORGANIZATION_BLOCK\n' },
        { address: "plc:PLC_1/blocks/10_Drives/Fx_Motor", content: fb("Fx_Motor") },
        { address: "plc:PLC_1/blocks/10_Drives/Pumps/Fx_Pump", content: fb("Fx_Pump", "\n\tIF #speed > 100 THEN\n\t\t#running := FALSE;\n\tEND_IF;") },
        { address: "plc:PLC_1/blocks/Fx_Broken", content: 'FUNCTION "Fx_Broken" : Void\nVERSION : 0.1\nBEGIN\n\t#undeclared := TRUE;\nEND_FUNCTION\n' },
        { address: "plc:PLC_1/blocks/Fx_Global", form: "db", content: 'DATA_BLOCK "Fx_Global"\nVERSION : 0.1\n   VAR\n      ready : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n' },
        { address: "plc:PLC_1/types/Fx_Type", content: 'TYPE "Fx_Type"\nVERSION : 0.1\n   STRUCT\n      a : Bool;\n   END_STRUCT;\n\nEND_TYPE\n' },
        {
          address: "plc:PLC_1/blocks/Fx_Secret",
          content: "protected",
          entry: { address: "plc:PLC_1/blocks/Fx_Secret", kind: "block", language: "SCL", knowHowProtected: true, isFailsafe: false, isSystem: false, fingerprint: "fp:secret" },
        },
      ],
    }),
  );
}

const fakeEnv = (repo: string, objects: string) => ({ RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([join(repo, "packages", "cli", "test", "fake-bridge.mjs")]), FAKE_OBJECTS: objects });

/** An empty folder (no rung.toml) next to a fake TIA project: the first-run flow. */
export function createFreshFolder(repo: string, base: string): FakeWorkspace {
  const dir = join(base, "fresh-ws");
  mkdirSync(dir, { recursive: true });
  const objects = join(base, "fresh-objects.json");
  writeObjects(objects);
  return { dir, objects, env: fakeEnv(repo, objects) };
}

export function createFakeWorkspace(repo: string, base: string): FakeWorkspace {
  const dir = join(base, "fake-ws");
  mkdirSync(dir, { recursive: true });
  const objects = join(base, "fake-objects.json");
  writeObjects(objects);
  const env = fakeEnv(repo, objects);
  for (const args of [["init", "--writes"], ["pull"]]) {
    const r = rungCli(repo, dir, env, ...args);
    if (r.code !== 0) throw new Error(`rung ${args.join(" ")} failed (${r.code}):\n${r.output}`);
  }
  // A unit test for rung test.
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "tests", "Fx_Motor.test.yaml"),
    "block: Fx_Motor\ncases:\n  - name: follows start\n    steps:\n      - set: { start: true }\n      - cycle: 1\n      - expect: { running: true }\n",
  );
  // Conflict: Fx_Motor changed on both sides.
  const motor = join(dir, "plc", "PLC_1", "blocks", "10_Drives", "Fx_Motor.scl");
  writeFileSync(motor, readFileSync(motor, "utf8").replace("#running := #start;", "#running := NOT #start;"));
  const db = JSON.parse(readFileSync(objects, "utf8")) as { objects: { address: string; content: string }[] };
  const m = db.objects.find((o) => o.address.endsWith("/Fx_Motor"))!;
  m.content = m.content.replace("#running := #start;", "#running := #start AND TRUE;");
  writeFileSync(objects, JSON.stringify(db));
  const s = rungCli(repo, dir, env, "sync");
  if (!/conflicts 1/.test(s.output)) throw new Error(`expected a conflict after rung sync:\n${s.output}`);
  return { dir, objects, env };
}
