// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { WorkspaceIndex } from "@rung/lsp";
import { runTestFile, toMs } from "@rung/sim";
import { main } from "../src/main.js";
import { discoverWorkspace, parseDiscoveryConfig, discoveryForFile } from "../src/discover.js";

const dirs: string[] = [];
const source = (body: string) => `FUNCTION_BLOCK "Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nVAR_OUTPUT\n Running : Bool;\nEND_VAR\nBEGIN\n${body}\nEND_FUNCTION_BLOCK`;
function fixture(body = "#Running := #Start;") {
  const dir = mkdtempSync(join(tmpdir(), "rung-discover-")); dirs.push(dir);
  mkdirSync(join(dir, "blocks"));
  writeFileSync(join(dir, "rung.toml"), 'format = 1\n[project]\npath = "unused.ap20"\ntiaVersion = "V20"\n');
  const file = join(dir, "blocks/Motor.scl"); writeFileSync(file, source("#Running := #Start OR #Running;"));
  const git = (...args: string[]) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
  git("init", "-q"); git("add", "."); git("commit", "-qm", "reference"); writeFileSync(file, source(body));
  return dir;
}
const config = () => parseDiscoveryConfig("block: Motor\ninputs: { Start: [false, true] }\noutputs: [Running]\nsearch: { maxCycles: 8, maxEvents: 4, maxRuns: 100, holds: [1, 2, 4], timeoutMs: 5000 }\n");
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("discover on real source revisions", () => {
  it("finds an unwritten latch scenario and exports a test passing on the reference, failing now", async () => {
    const dir = fixture(), result = await discoverWorkspace(dir, config(), "HEAD");
    expect(result.status).toBe("found");
    expect(result.witness?.difference).toMatchObject({ signal: "Running", cycle: 2, before: true, after: false });
    expect(result.reference.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.reference.sourceHash).not.toBe(result.current.sourceHash);
    expect(result.alsoChanged).toBeUndefined();
    expect(result.sources?.before.text).toContain("#Start OR #Running");
    expect(result.sources?.after.file).toBe("blocks/Motor.scl");
    expect(result.findings?.[0]?.cause).toMatchObject({ before: { scan: 2, line: 9, value: true }, after: { scan: 2, line: 9, value: false } });
    // the write reads Start and Running; the reference read Running TRUE from the scan before
    expect(result.findings?.[0]?.cause.before?.because).toEqual([{ line: 9, reads: [{ name: "#Start", value: false }, { name: "#Running", value: true }] }]);
    expect(result.changedLines).toEqual({ before: [9], after: [9] });
    const index = new WorkspaceIndex(); await index.load(dir);
    const run = await runTestFile(index, "witness.test.yaml", result.referenceTest!);
    expect(run.cases[0]?.passed).toBe(false);
    writeFileSync(join(dir, "blocks/Motor.scl"), source("#Running := #Start OR #Running;"));
    await index.load(dir);
    const base = await runTestFile(index, "witness.test.yaml", result.referenceTest!);
    expect(base.cases[0]?.passed).toBe(true);
  });
  it("same program gives bounded not-found without equivalence claims", async () => {
    const dir = fixture("#Running := #Start OR #Running;");
    const r = await discoverWorkspace(dir, config(), "HEAD"); expect(r.status).toBe("not-found"); expect(r.referenceTest).toBeUndefined();
  });
  it("exports every observation from the same scan in a multi-output witness", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    writeFileSync(file, source("#Running := NOT #Start;").replace("Running : Bool;", "Running : Bool;\n Count : Int;"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "two outputs"], { cwd: dir });
    writeFileSync(file, source("#Running := #Start;").replace("Running : Bool;", "Running : Bool;\n Count : Int;"));
    const result = await discoverWorkspace(dir, { ...config(), outputs: ["Running", "Count"] }, "HEAD");
    expect(result.status).toBe("found");
    expect(result.referenceTest).toContain("Count: 0");
    const index = new WorkspaceIndex(); await index.load(dir);
    expect((await runTestFile(index, "w.test.yaml", result.referenceTest!)).cases[0]?.passed).toBe(false);
  });
  it("infers the complete Boolean input domain for a selected block without a configuration file", async () => {
    const dir = fixture(), c = await discoveryForFile(dir, join(dir, "blocks/Motor.scl"));
    expect(c.inputs).toEqual({ Start: [false, true] }); expect(c.outputs).toEqual(["Running"]);
    expect((await discoverWorkspace(dir, c, "HEAD")).status).toBe("found");
  });
  it("infers numeric domains around the thresholds the source compares against", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const level = (op: string) => source(`#Running := #Level ${op} 80;`).replace("Start : Bool;", "Start : Bool;\n Level : Int;");
    writeFileSync(file, level(">"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "level"], { cwd: dir });
    writeFileSync(file, level(">="));
    const c = await discoveryForFile(dir, file);
    expect(c.inputs.Level).toEqual(expect.arrayContaining([0, 79, 80, 81]));
    const r = await discoverWorkspace(dir, c, "HEAD");
    expect(r.status).toBe("found"); expect(r.witness?.steps.at(-1)?.set.Level).toBe(80);
  });
  it("scales the scan time and holds to the timers in the source", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const timer = (pt: string) => `FUNCTION_BLOCK "Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nVAR_OUTPUT\n Running : Bool;\nEND_VAR\nVAR\n t : TON_TIME;\nEND_VAR\nBEGIN\n #t(IN := #Start, PT := ${pt});\n #Running := #t.Q;\nEND_FUNCTION_BLOCK`;
    writeFileSync(file, timer("T#5s"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "timer"], { cwd: dir });
    writeFileSync(file, timer("T#6s"));
    const c = await discoveryForFile(dir, file, [timer("T#5s")]);
    expect(c.maxCycles * toMs(c.cycle)).toBeGreaterThan(6000);
    const r = await discoverWorkspace(dir, c, "HEAD");
    expect(r.status).toBe("found"); expect(r.witness?.difference).toMatchObject({ signal: "Running", before: true, after: false });
  });
  it("holds a TIME parameter at its start value and finds a changed reset priority behind a timer", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const valve = (logic: string) => `FUNCTION_BLOCK "Motor"
VAR_INPUT
 Cmd : Bool;
 FbOpen : Bool;
 Ack : Bool;
 Delay : Time := T#3S;
END_VAR
VAR_OUTPUT
 Out : Bool;
 Fault : Bool;
END_VAR
VAR
 t : TON_TIME;
END_VAR
BEGIN
 #t(IN := #Out AND NOT #FbOpen, PT := #Delay);
 ${logic}
 #Out := #Cmd AND NOT #Fault;
END_FUNCTION_BLOCK`;
    writeFileSync(file, valve("IF #t.Q THEN #Fault := TRUE; ELSIF #Ack THEN #Fault := FALSE; END_IF;"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "valve"], { cwd: dir });
    writeFileSync(file, valve("IF #Ack THEN #Fault := FALSE; ELSIF #t.Q THEN #Fault := TRUE; END_IF;"));
    const c = await discoveryForFile(dir, file);
    expect(c.inputs.Delay).toBeUndefined(); expect(c.fixed).toEqual(["Delay"]);
    const r = await discoverWorkspace(dir, c, "HEAD");
    expect(r.status).toBe("found");
  }, 60_000);
  it("walks a recipe sequencer: thresholds from UDT start values, recipe and alarm left alone", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    writeFileSync(join(dir, "blocks/Recipe.udt"), 'TYPE "Recipe"\nSTRUCT\n LevelA : Real := 40.0;\n MixTime : Time := T#2S;\nEND_STRUCT;\nEND_TYPE');
    const batch = (drain: string) => `FUNCTION_BLOCK "Motor"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nVAR_INPUT\n Start : Bool;\n Level : Real;\n Recipe : "Recipe";\nEND_VAR\nVAR_OUTPUT\n Step : Int;\n Drain : Bool;\nEND_VAR\nVAR\n mix : TON_TIME;\n al : Program_Alarm;\nEND_VAR\nBEGIN\n CASE #Step OF\n  0: IF #Start THEN #Step := 10; END_IF;\n  10: IF #Level >= #Recipe.LevelA THEN #Step := 20; END_IF;\n  20: IF #mix.Q THEN #Step := 30; END_IF;\n  30: IF ${drain} THEN #Step := 0; END_IF;\n END_CASE;\n #mix(IN := #Step = 20, PT := #Recipe.MixTime);\n #Drain := #Step = 30;\n #al(SIG := #Drain);\nEND_FUNCTION_BLOCK`;
    writeFileSync(file, batch("#Level <= 1.0"));
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qm", "batch"], { cwd: dir });
    writeFileSync(file, batch("#Level < 1.0"));
    const c = await discoveryForFile(dir, file);
    expect(c.inputs.Level).toEqual(expect.arrayContaining([0, 1, 40]));
    expect(c.inputs["Recipe.LevelA"]).toEqual(expect.arrayContaining([0, 40]));
    expect(c.inputs["Recipe.LevelA"]![0]).toBe(40); // its rest is its start value
    expect(Object.values(c.inputs).flat()).not.toContain(0.1); // not from the VERSION header
    expect(c.fixed).toEqual(["Recipe.MixTime"]);
    const r = await discoverWorkspace(dir, c, "HEAD");
    expect(r.status).toBe("found");
    expect(r.witness?.steps.at(-1)?.set.Level).toBe(1);
    expect(r.assumptions.join(" ")).toMatch(/Recipe\.MixTime.*PROGRAM_ALARM/s);
  }, 60_000);
  it("reports each distinct difference as its own finding, test case and cause", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const two = (run: string, alarm: string) => source(`#Running := ${run};\n#Alarm := ${alarm};`).replace("Running : Bool;", "Running : Bool;\n Alarm : Bool;").replace("Start : Bool;", "Start : Bool;\n Stop : Bool;");
    writeFileSync(file, two("#Start", "#Stop"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "two"], { cwd: dir });
    writeFileSync(file, two("#Start AND NOT #Stop", "#Stop AND NOT #Start"));
    const r = await discoverWorkspace(dir, await discoveryForFile(dir, file), "HEAD");
    expect(r.findings?.map(f => f.difference.signal).sort()).toEqual(["Alarm", "Running"]);
    for (const f of r.findings!) expect(f.cause.after?.line).toBe(f.difference.signal === "Running" ? 11 : 12);
    const index = new WorkspaceIndex(); await index.load(dir);
    const run = await runTestFile(index, "w.test.yaml", r.referenceTest!);
    expect(run.cases).toHaveLength(2);
    expect(run.cases.every(c => !c.passed)).toBe(true);
  });
  it("shows the IF a write ran inside and the values its condition read", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const gated = (cond: string) => source(`IF ${cond} THEN\n #Running := TRUE;\nELSE\n #Running := FALSE;\nEND_IF;`).replace("Start : Bool;", "Start : Bool;\n Permit : Bool;");
    writeFileSync(file, gated("#Start AND #Permit"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "gate"], { cwd: dir });
    writeFileSync(file, gated("#Start"));
    const r = await discoverWorkspace(dir, await discoveryForFile(dir, file), "HEAD");
    const cause = r.findings![0]!.cause;
    expect(cause.before).toMatchObject({ line: 13, value: false });
    expect(cause.before?.because?.[0]).toEqual({ line: 10, reads: [{ name: "#Start", value: true }, { name: "#Permit", value: false }] });
    expect(cause.after?.because?.[0]).toEqual({ line: 10, reads: [{ name: "#Start", value: true }] });
  });
  it("drives the members an in/out only reads and observes the ones it writes", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    writeFileSync(join(dir, "blocks/Vessel.udt"), 'TYPE "Vessel"\nSTRUCT\n Level : Real;\n HighLimit : Real := 90.0;\n High : Bool;\nEND_STRUCT;\nEND_TYPE');
    const limits = (op: string) => `FUNCTION "Motor" : Void\nVAR_IN_OUT\n Tank : "Vessel";\nEND_VAR\nBEGIN\n #Tank.High := #Tank.Level ${op} #Tank.HighLimit;\nEND_FUNCTION`;
    writeFileSync(file, limits(">="));
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qm", "limits"], { cwd: dir });
    writeFileSync(file, limits(">"));
    const c = await discoveryForFile(dir, file);
    expect(Object.keys(c.inputs).sort()).toEqual(["Tank.HighLimit", "Tank.Level"]);
    expect(c.inputs["Tank.Level"]).toEqual(expect.arrayContaining([90]));
    expect(c.outputs).toEqual(["Tank.High"]);
    const r = await discoverWorkspace(dir, c, "HEAD");
    expect(r.status).toBe("found");
    expect(r.witness?.difference).toMatchObject({ signal: "Tank.High", before: true, after: false });
    expect(r.findings![0]!.cause.after).toMatchObject({ line: 6, value: false });
    writeFileSync(join(dir, "blocks/Vessel.udt"), 'TYPE "Vessel"\nSTRUCT\n Level : Real;\n HighLimit : Real := 95.0;\n High : Bool;\nEND_STRUCT;\nEND_TYPE');
    writeFileSync(join(dir, "blocks/Other.udt"), 'TYPE "Other"\nSTRUCT\n X : Bool;\nEND_STRUCT;\nEND_TYPE'); // changed, but Motor does not use it
    expect((await discoverWorkspace(dir, c, "HEAD")).alsoChanged).toEqual(["blocks/Vessel.udt"]);
  });
  it("starts the next search from the scenarios the last one reached, unless told to start fresh", async () => {
    const dir = fixture();
    const messages: string[] = [], io = { cwd: dir, env: {}, stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
    const once = async (...extra: string[]) => { messages.length = 0; expect(await main(["discover", "--file", "blocks/Motor.scl", "--json", ...extra], io), messages.join("")).toBe(2); return JSON.parse(messages.join("")) as { reused: number; corpus?: unknown }; };
    expect((await once()).reused).toBe(0);
    const second = await once();
    expect(second.reused).toBeGreaterThan(0);
    expect(second.corpus).toBeUndefined();
    expect((await once("--fresh")).reused).toBe(0);
    const corpus = join(dir, ".rung/discover/corpus/_/Motor.json");
    writeFileSync(corpus, "{ not json");
    expect((await once()).reused).toBe(0);
    writeFileSync(corpus, JSON.stringify({ version: 1, scenarios: [[{ set: { Start: "x" }, cycles: 1 }], [{ set: { Start: true }, cycles: 999 }]] }));
    expect((await once()).reused).toBe(0);
  });
  it("finds a real timer boundary and records the differing intermediate scan", async () => {
    const dir = fixture();
    const timer = (pt: string) => `FUNCTION_BLOCK "Motor"\nVAR_INPUT\n Start : Bool;\nEND_VAR\nVAR_OUTPUT\n Running : Bool;\nEND_VAR\nVAR\n t : TON_TIME;\nEND_VAR\nBEGIN\n #t(IN := #Start, PT := ${pt});\n #Running := #t.Q;\nEND_FUNCTION_BLOCK`;
    const file = join(dir, "blocks/Motor.scl"); writeFileSync(file, timer("T#20ms"));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "timer"], { cwd: dir });
    writeFileSync(file, timer("T#30ms"));
    const r = await discoverWorkspace(dir, config(), "HEAD");
    expect(r.status).toBe("found"); expect(r.witness?.difference).toMatchObject({ cycle: 3, signal: "Running", before: true, after: false });
  });
  it("refuses absent observations and domains that try to drive a static/output", async () => {
    const dir = fixture();
    await expect(discoverWorkspace(dir, { ...config(), outputs: ["Typo"] }, "HEAD")).rejects.toThrow(/observation/i);
    await expect(discoverWorkspace(dir, { ...config(), inputs: { Running: [false, true] } }, "HEAD")).rejects.toThrow(/input/i);
  });
  it("reports unsupported execution rather than a found difference", async () => {
    const dir = fixture('"NotAvailable"();');
    await expect(discoverWorkspace(dir, config(), "HEAD")).rejects.toThrow(/stubs|NotAvailable/);
  });
  it("uses normal test numeric tolerance so an exported test always distinguishes revisions", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const numeric = (value: number) => source(`#Running := ${value};`).replace("Running : Bool", "Running : DInt");
    writeFileSync(file, numeric(10000000));
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "numeric reference"], { cwd: dir });
    writeFileSync(file, numeric(10000001));
    expect((await discoverWorkspace(dir, { ...config(), maxRuns: 4 }, "HEAD")).status).toBe("not-found");
    writeFileSync(file, numeric(10000100));
    const result = await discoverWorkspace(dir, config(), "HEAD");
    expect(result.status).toBe("found");
    const index = new WorkspaceIndex(); await index.load(dir);
    expect((await runTestFile(index, "w.test.yaml", result.referenceTest!)).cases[0]?.passed).toBe(false);
  });
  it("refuses implicit instruction stubs too", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    writeFileSync(file, source("#al(SIG := #Start); #Running := #al.Error;").replace("BEGIN", "VAR\n al : Program_Alarm;\nEND_VAR\nBEGIN"));
    await expect(discoverWorkspace(dir, config(), "HEAD")).rejects.toThrow(/stub/i);
  });
  it("preflights each domain value from fresh state within the one-scan horizon", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    const text = source("#i := #i + 1; #Running := #a[#i];").replace("BEGIN", "VAR\n i : Int;\n a : Array[1..1] of Bool;\nEND_VAR\nBEGIN");
    writeFileSync(file, text);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "single scan"], { cwd: dir });
    expect((await discoverWorkspace(dir, { ...config(), maxCycles: 1, maxEvents: 1, holds: [1], maxRuns: 2 }, "HEAD")).status).toBe("not-found");
  });
  it.each([false, true])("refuses nested interface changes (named type: %s)", async named => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl"), udt = join(dir, "blocks/Data.udt");
    const text = (type: string) => source("#Running := #Start;").replace("Running : Bool;", `Running : Bool;\n data : ${named ? '"Data"' : `Struct\n x : ${type};\nEND_STRUCT`};`);
    writeFileSync(file, text("Bool"));
    if (named) writeFileSync(udt, 'TYPE "Data"\nSTRUCT\n x : Bool;\nEND_STRUCT;\nEND_TYPE');
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qm", "nested interface"], { cwd: dir });
    if (named) writeFileSync(udt, 'TYPE "Data"\nSTRUCT\n x : Int;\nEND_STRUCT;\nEND_TYPE');
    else writeFileSync(file, text("Int"));
    await expect(discoverWorkspace(dir, config(), "HEAD")).rejects.toThrow(/interface/i);
  });
  it("refuses changed scalar alias definitions in the interface", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl"), udt = join(dir, "blocks/Data.st");
    writeFileSync(file, source("#Running := #Start;").replace("Running : Bool;", 'Running : Bool;\n data : "Data";'));
    writeFileSync(udt, 'TYPE Data : Bool;\nEND_TYPE');
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qm", "alias interface"], { cwd: dir });
    writeFileSync(udt, 'TYPE Data : Int;\nEND_TYPE');
    await expect(discoverWorkspace(dir, config(), "HEAD")).rejects.toThrow(/interface/i);
  });
  it("refuses an interface type change even when both revisions return the same number", async () => {
    const dir = fixture(), file = join(dir, "blocks/Motor.scl");
    writeFileSync(file, source("#Running := 0;").replace("Running : Bool", "Running : Int"));
    const committed = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "integer interface"], { cwd: dir });
    expect(committed.status).toBe(0);
    writeFileSync(file, source("#Running := 0;").replace("Running : Bool", "Running : DInt"));
    await expect(discoverWorkspace(dir, config(), "HEAD")).rejects.toThrow(/interface/i);
  });
  it("CLI creates a local workbench and never overwrites existing output", async () => {
    const dir = fixture(), cfg = join(dir, "motor.discover.yaml"), out = join(dir, "evidence");
    writeFileSync(cfg, "block: Motor\ninputs: { Start: [false, true] }\noutputs: [Running]\nsearch: { maxRuns: 60 }\n");
    const messages: string[] = [], io = { cwd: dir, env: {}, stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
    expect(await main(["discover", cfg, "--against", "HEAD", "--out", out, "--json"], io), messages.join("")).toBe(2);
    expect(existsSync(join(out, "report.html"))).toBe(true);
    const before = readFileSync(join(out, "evidence.json"), "utf8");
    expect(await main(["discover", cfg, "--against", "HEAD", "--out", out], io)).toBe(1);
    expect(readFileSync(join(out, "evidence.json"), "utf8")).toBe(before);
  });
  it("with a committed change and no revision, compares against the version before that commit", async () => {
    const dir = fixture();
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qam", "change"], { cwd: dir });
    const parent = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const messages: string[] = [], io = { cwd: dir, env: {}, stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
    expect(await main(["discover", "--file", "blocks/Motor.scl", "--json"], io), messages.join("")).toBe(2);
    expect(JSON.parse(messages.join("")).reference.commit).toBe(parent);
  });
  it("with no block given, searches every FB/FC changed since the revision", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "blocks/Pump.scl"), source("#Running := #Start;").replace('"Motor"', '"Pump"'));
    spawnSync("git", ["add", "blocks/Pump.scl"], { cwd: dir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-qm", "pump"], { cwd: dir });
    const messages: string[] = [], io = { cwd: dir, env: {}, stdout: (s: string) => messages.push(s), stderr: (s: string) => messages.push(s) };
    expect(await main(["discover", "--json"], io), messages.join("")).toBe(2);
    const out = JSON.parse(messages.join("")) as { results: { block: string; status: string; directory?: string }[] };
    expect(out.results.map(r => [r.block, r.status])).toEqual([["Motor", "found"]]);
    expect(existsSync(join(out.results[0]!.directory!, "report.html"))).toBe(true);
    writeFileSync(join(dir, "blocks/Fresh.scl"), source("#Running := #Start;").replace('"Motor"', '"Fresh"'));
    messages.length = 0;
    expect(await main(["discover", "--json"], io)).toBe(2);
    expect(JSON.parse(messages.join("")).results.find((r: { block: string }) => r.block === "Fresh")).toMatchObject({ status: "unavailable", summary: expect.stringMatching(/new since HEAD/) });
    rmSync(join(dir, "blocks/Fresh.scl"));
    spawnSync("git", ["checkout", "--", "."], { cwd: dir });
    rmSync(join(dir, ".rung"), { recursive: true, force: true });
    messages.length = 0;
    expect(await main(["discover"], io)).toBe(1);
    expect(messages.join("")).toMatch(/No changed FB or FC/);
  });
  it.each(["block: Motor\ninputs: { Start: [false,true] }\noutputs: []", "block: Motor\ninputs: { Start: [false,true] }\noutputs: [Running]\nunknown: true", "block: Motor\nblock: Other", "block: Motor\ninputs: { Start: [false,true] }\noutputs: [Running]\nsearch: { toString: 1 }"]) ("refuses invalid config", text => { expect(() => parseDiscoveryConfig(text)).toThrow(); });
});
