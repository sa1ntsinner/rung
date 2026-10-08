// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, HELP, main, serverNote } from "../src/main.js";
import { decodeArgs } from "../src/common.js";
import { StateStore } from "@rung/core";
import { OwnerServer } from "@rung/sync";

const fakeScript = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const PROJECT = "C:\\fx\\RungFixture\\RungFixture.ap20";

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rung-cli-"));
  const objects = join(dir, "..", `objects-${Date.now()}-${Math.random()}.json`);
  writeFileSync(
    objects,
    JSON.stringify({
      project: { name: "RungFixture", path: PROJECT, tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false },
      objects: [
        { address: "plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor", content: 'FUNCTION_BLOCK "Fx_Motor"\r\nEND_FUNCTION_BLOCK\r\n' },
        { address: "plc:PLC_1/blocks/Motor%2FValve 1", content: "// valve\n" },
      ],
    }),
  );
  const out: string[] = [];
  const err: string[] = [];
  const run = (...args: string[]) =>
    main(args, {
      cwd: dir,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
      env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: objects, ...env },
    });
  return { dir, run, out, err, objects };
}

describe("rung CLI from inside a workspace", () => {
  it("a notice the last pull showed is counted, not repeated; --verbose shows it again", async () => {
    const t = setup();
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    db.objects[1].entry = { address: db.objects[1].address, kind: "block", language: "SCL", knowHowProtected: false, isFailsafe: false, isSystem: false, isConsistent: false, fingerprint: "fp:" + createHash("sha256").update(db.objects[1].content).digest("hex").slice(0, 8) };
    writeFileSync(t.objects, JSON.stringify(db));
    expect(await t.run("init")).toBe(0);
    await t.run("pull"); // the first pull exports; the notice comes with the next ones
    t.out.length = 0;
    await t.run("pull");
    expect(t.out.join("")).toMatch(/INCONSISTENT\s+plc\/PLC_1\/blocks\/Motor%2FValve 1\.scl/);
    t.out.length = 0;
    await t.run("pull");
    expect(t.out.join("")).not.toMatch(/INCONSISTENT\s+plc/);
    expect(t.out.join("")).toContain("(1 notice as on the last pull: INCONSISTENT; rung pull --verbose shows them)");
    t.out.length = 0;
    await t.run("pull", "--verbose");
    expect(t.out.join("")).toMatch(/INCONSISTENT\s+plc/);
  });

  it("pull, status and sync find rung.toml in a parent folder", async () => {
    const t = setup();
    expect(await t.run("init")).toBe(0);
    const sub = join(t.dir, "plc");
    mkdirSync(sub, { recursive: true });
    const io = { cwd: sub, stdout: (s: string) => t.out.push(s), stderr: (s: string) => t.err.push(s), env: { RUNG_BRIDGE: process.execPath, RUNG_BRIDGE_ARGS: JSON.stringify([fakeScript]), FAKE_OBJECTS: t.objects } };
    expect(await main(["pull"], io)).toBe(0);
    expect(existsSync(join(t.dir, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl"))).toBe(true);
    expect(existsSync(join(sub, "rung.toml"))).toBe(false);
    expect(await main(["status"], io)).toBe(0);
  });
});

describe("TIA Portal on another PC (Linux, macOS): the bridge over ssh", () => {
  it("init --host, then pull and sync carry the files across the connection", async () => {
    const log = join(tmpdir(), `ssh-${Date.now()}-${Math.random()}.log`);
    const ssh = { RUNG_SSH: process.execPath, RUNG_SSH_ARGS: JSON.stringify([fileURLToPath(new URL("./fake-ssh.mjs", import.meta.url))]), FAKE_SSH_LOG: log };
    const t = setup(ssh);
    expect(await t.run("init", "--host", "elmir@tia-pc", "--project", PROJECT, "--writes")).toBe(0);
    expect(readFileSync(join(t.dir, "rung.toml"), "utf8")).toMatch(/\[bridge\][\s\S]*host = "elmir@tia-pc"/);
    const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]!) as string[];
    expect(first.slice(0, 5)).toEqual(["-T", "-o", "BatchMode=yes", "--", "elmir@tia-pc"]);
    expect(first[5]).toMatch(/^rung bridge --args [A-Za-z0-9_-]+$/);
    expect(decodeArgs(first[5]!.split(" ")[3]!)).toEqual(["--project", PROJECT, "--open-headless"]);

    expect(await t.run("pull")).toBe(0);
    const motor = join(t.dir, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl");
    expect(readFileSync(motor, "utf8")).toContain('FUNCTION_BLOCK "Fx_Motor"');
    writeFileSync(motor, 'FUNCTION_BLOCK "Fx_Motor"\r\nbegin\r\nEND_FUNCTION_BLOCK\r\n');
    expect(await t.run("sync")).toBe(0);
    expect(readFileSync(motor, "utf8")).toContain("BEGIN"); // TIA's form came back across the connection
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.inline).toContain("export");
    expect(db.inline).toContain("import obj.scl");
  });

  it("a project path cmd.exe would expand or run arrives as it is; a host ssh would read as an option is refused", async () => {
    const log = join(tmpdir(), `ssh-${Date.now()}-${Math.random()}.log`);
    const t = setup({ RUNG_SSH: process.execPath, RUNG_SSH_ARGS: JSON.stringify([fileURLToPath(new URL("./fake-ssh.mjs", import.meta.url))]), FAKE_SSH_LOG: log });
    const hostile = 'C:\\fx\\a" & whoami & rem "\\%USERNAME%\\Line^3.ap20';
    await t.run("init", "--host", "elmir@tia-pc", "--project", hostile);
    const first = JSON.parse(readFileSync(log, "utf8").split("\n")[0]!) as string[];
    expect(decodeArgs(first[5]!.split(" ")[3]!)).toEqual(["--project", hostile, "--open-headless"]);
    expect(await t.run("init", "--host=-oProxyCommand=calc", "--project", PROJECT)).toBe(1);
    expect(t.err.join("")).toContain("is not an ssh destination");
  });

  it("--rebind saves the host the project was looked at on: a new --host replaces the old one, none binds here", async () => {
    const ssh = { RUNG_SSH: process.execPath, RUNG_SSH_ARGS: JSON.stringify([fileURLToPath(new URL("./fake-ssh.mjs", import.meta.url))]) };
    const t = setup(ssh);
    expect(await t.run("init", "--host", "elmir@pc-a", "--project", PROJECT)).toBe(0);
    expect(await t.run("init", "--rebind", "--host", "elmir@pc-b", "--project", PROJECT)).toBe(0);
    expect(readFileSync(join(t.dir, "rung.toml"), "utf8")).toMatch(/host = "elmir@pc-b"/);
    expect(await t.run("init", "--rebind", "--project", PROJECT)).toBe(0);
    expect(readFileSync(join(t.dir, "rung.toml"), "utf8")).not.toMatch(/host =/);
  });

  it("says what to check when nothing answers on the other PC", async () => {
    const t = setup({ RUNG_SSH: process.execPath, RUNG_SSH_ARGS: JSON.stringify(["-e", "process.exit(255)"]) });
    expect(await t.run("init", "--host", "elmir@tia-pc", "--project", PROJECT)).toBe(1);
    expect(t.err.join("")).toMatch(/BRIDGE_UNREACHABLE: no bridge answered on elmir@tia-pc .*ssh elmir@tia-pc.*rung bridge/);
  });
});

describe("upload from a PLC (TIA Portal's Upload device as new station)", () => {
  it("rung upload reads the PLC into the bound project as a new station", async () => {
    const t = setup();
    expect(await t.run("init")).toBe(0);
    // writes into the project are off after init: an upload adds a station, so it waits for rung writes on
    expect(await t.run("upload", "--ip", "192.168.0.9", "--use", "Intel(R) Ethernet")).toBe(1);
    expect(t.err.join("")).toContain("WRITES_OFF");
    expect(await t.run("writes", "on")).toBe(0);
    t.err.length = 0;
    const code = await t.run("upload", "--ip", "192.168.0.9", "--use", "Intel(R) Ethernet");
    expect(t.err.join("")).toBe("reading the station at 192.168.0.9 into the project (the PLC is only read) …\n");
    expect(code).toBe(0);
    expect(t.out.join("")).toContain('uploaded the station "S7-1500 station_2" from 192.168.0.9: PLC_2 (Success)\nNext: rung pull\n');
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.uploads[0].request).toEqual({ address: "192.168.0.9", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 1 });
    expect(await t.run("upload", "--ip", "192.168.0")).toBe(1);
    expect(t.err.join("")).toContain("192.168.0 is not an IP address such as 192.168.0.1");
  });

  it("rung init --from-plc makes a new project from the PLC and binds it", async () => {
    const t = setup();
    expect(await t.run("init", "--from-plc", "192.168.0.9", "--project", PROJECT)).toBe(0);
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    expect(db.uploads[0].argv).toEqual(expect.arrayContaining(["--open-headless", "--create-project", "--allow-import"]));
    expect(t.out.join("")).toMatch(/uploaded the station "S7-1500 station_2"[\s\S]*Bound .* \(V20, devices: PLC_1, PLC_2\)/);
    expect(existsSync(join(t.dir, "rung.toml"))).toBe(true);
    expect(await setup().run("init", "--from-plc", "192.168.0.9")).toBe(1);
  });

  it("a station TIA Portal could not save is not a success: init --from-plc binds nothing", async () => {
    const t = setup({ FAKE_SAVE_ERROR: "There is not enough space on the disk." });
    expect(await t.run("init", "--from-plc", "192.168.0.9", "--project", PROJECT)).toBe(3);
    expect(t.err.join("")).toContain("could not be saved (There is not enough space on the disk.)");
    expect(t.err.join("")).toContain("rung took the station out again: the project is as it was");
    expect(existsSync(join(t.dir, "rung.toml"))).toBe(false);
  });

  it("rung init --from-plc checks its arguments before it uploads anything", async () => {
    const t = setup();
    expect(await t.run("init", "--from-plc", "192.168.0.9", "--project", PROJECT, "--tia", "V99")).toBe(1);
    expect(t.err.join("")).toContain("unsupported version V99");
    expect(await t.run("init", "--from-plc", "192.168.0.9", "--project", PROJECT, "--tia", "V21")).toBe(1);
    expect(t.err.join("")).toContain("does not match");
    const db = existsSync(t.objects) ? JSON.parse(readFileSync(t.objects, "utf8")) : {};
    expect(db.uploads ?? []).toEqual([]);
  });
});

describe("rung CLI", () => {
  it("help names every command and every option the commands take", () => {
    // codesys-bridge is started by rung itself (rung init --project x.project), never by a person
    const commands = Object.keys(COMMANDS).filter((c) => c !== "codesys-bridge");
    expect(commands.filter((c) => !HELP.includes(`rung ${c}`))).toEqual([]);
    const options = [...new Set(commands.flatMap((c) => COMMANDS[c]!.options))];
    expect(options.filter((o) => !HELP.includes(`--${o}`) && !(o === "yes" && HELP.includes("-y")))).toEqual([]);
    expect(HELP).toContain("rung bridge");
  });

  it("an unknown command gets one line, with the command it probably meant", async () => {
    const t = setup();
    expect(await t.run("pul")).toBe(1);
    expect(await t.run("asignments")).toBe(1);
    expect(await t.run("frobnicate")).toBe(1);
    expect(t.err.join("")).toBe(
      "rung: unknown command pul (did you mean rung pull?); rung --help lists the commands\n" +
        "rung: unknown command asignments (did you mean rung assignments?); rung --help lists the commands\n" +
        "rung: unknown command frobnicate; rung --help lists the commands\n",
    );
  });

  it("prints help and version", async () => {
    const t = setup();
    expect(await t.run("--help")).toBe(0);
    expect(t.out.join("")).toMatch(/rung init/);
    expect(await t.run("--version")).toBe(0);
  });

  it("each command's help lists only its usage, its options and a runnable example", async () => {
    const t = setup();
    for (const [cmd, spec] of Object.entries(COMMANDS)) {
      t.out.length = 0;
      expect(await t.run(cmd, "--help")).toBe(0);
      const text = t.out.join("");
      expect(text).toContain(`rung ${cmd}`);
      expect(text).toContain("Example:\n  rung ");
      for (const opt of spec.options) expect(text).toContain(`--${opt}`);
      expect(text).not.toContain("Environment:");
      if (cmd !== "test") expect(text).not.toContain("  rung test ");
    }
    t.out.length = 0;
    await t.run("test", "-h");
    expect(t.out.join("")).toContain("--filter <text>  a part of a test file's path or of a case's name (any letter case), or a block name");
    t.out.length = 0;
    expect(await t.run("bridge", "--help")).toBe(0);
    expect(t.out.join("")).toContain("Example:\n  rung bridge --tia V20\n");
  });

  it("init binds the single open project and writes config, gitignore and AGENTS.md", async () => {
    const t = setup();
    expect(await t.run("init")).toBe(0);
    const toml = readFileSync(join(t.dir, "rung.toml"), "utf8");
    expect(toml).toContain("RungFixture.ap20");
    expect(readFileSync(join(t.dir, ".gitignore"), "utf8")).toContain(".rung/");
    expect(existsSync(join(t.dir, "AGENTS.md"))).toBe(true);
  });

  it("init refuses to overwrite an existing workspace without --rebind", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("init")).toBe(1);
    expect(t.err.join("")).toMatch(/already/);
    expect(await t.run("init", "--rebind")).toBe(0);
  });

  it("stops at options and arguments a command does not take", async () => {
    const t = setup();
    expect(await t.run("pull", "--yes")).toBe(1);
    expect(t.err.join("")).toMatch(/rung pull has no --yes/);
    expect(await t.run("status", "a", "b")).toBe(1);
    expect(t.err.join("")).toMatch(/rung status takes one argument; unexpected: b/);
    expect(await t.run("resolve", "x.scl", "--ours", "--theirs")).toBe(1);
    expect(t.err.join("")).toMatch(/--ours and --theirs exclude each other/);
    // a typo: the option of that command it most likely meant
    t.err.length = 0;
    expect(await t.run("setup", "--dryrun")).toBe(1);
    expect(await t.run("test", "--filer", "Fx_Motor")).toBe(1);
    expect(await t.run("setup", "--dry-run", "--agent", "claude")).toBe(1);
    expect(await t.run("--verison")).toBe(1);
    expect(t.err).toEqual([
      "rung: rung setup has no --dryrun; did you mean --dry-run? (rung --help)\n",
      "rung: rung test has no --filer; did you mean --filter? (rung --help)\n",
      "rung: rung setup has no --agent; did you mean --agents? (rung --help)\n",
      "rung: unknown option --verison; did you mean --version? (rung --help)\n",
    ]);
  });

  it("assignments lists each PLC of the workspace on its own; two PLCs' addresses never overlap", async () => {
    const t = setup();
    await t.run("init");
    for (const [plc, tag] of [["PLC_1", "Speed AT %MW10 : Int"], ["PLC_2", "Level AT %MW11 : Int"]]) {
      mkdirSync(join(t.dir, "plc", plc!, "tags"), { recursive: true });
      writeFileSync(join(t.dir, "plc", plc!, "tags", "IO.tags.st"), `VAR_GLOBAL\n    ${tag};\nEND_VAR\n`);
    }
    t.out.length = 0;
    expect(await t.run("assignments")).toBe(0);
    expect(t.out.join("")).toBe("Bit memory of PLC_1\n  %MW10      Speed : Int (IO)\n\nBit memory of PLC_2\n  %MW11      Level : Int (IO)\n");
  });

  it("lsp and mcp typed in a terminal say what they are for; started by an editor or agent, nothing", () => {
    expect(serverNote("lsp", true)).toBe("rung lsp is the language server your editor starts (rung setup --editors sets that up); it now waits for an editor on stdin, Ctrl+C stops it\n");
    expect(serverNote("mcp", true)).toBe("rung mcp is the MCP server an AI agent starts (rung setup --agents sets that up); it now waits for an agent on stdin, Ctrl+C stops it\n");
    expect([serverNote("lsp", false), serverNote("mcp", false), serverNote("status", true)]).toEqual([undefined, undefined, undefined]);
  });

  it("assignments lists S5 timers and counters under their own headings", async () => {
    const t = setup();
    await t.run("init");
    mkdirSync(join(t.dir, "plc", "PLC_1", "tags"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "tags", "Old.tags.st"), "VAR_GLOBAL\n    Fx_Delay AT %T5 : Timer;\n    Fx_Parts AT %Z2 : Counter;\nEND_VAR\n");
    t.out.length = 0;
    expect(await t.run("assignments")).toBe(0);
    expect(t.out.join("")).toBe("Timers\n  %T5        Fx_Delay : Timer (Old)\n\nCounters\n  %C2        Fx_Parts : Counter (Old)\n");
  });

  it("test says when an expected value is text in quotes but the value is a BOOL or a number", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Fx_Run.scl"), 'FUNCTION_BLOCK "Fx_Run"\n   VAR_INPUT\n      Start : Bool;\n   END_VAR\n   VAR_OUTPUT\n      Running : Bool;\n      Count : Int;\n   END_VAR\nBEGIN\n   #Running := #Start;\n   #Count := 2;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "run.test.yaml"), "block: Fx_Run\ncases:\n  - name: runs\n    steps:\n      - set: { Start: true }\n      - cycle: 1\n      - expect: { Running: \"false\", Count: \"3\" }\n");
    expect(await t.run("test")).toBe(2);
    expect(t.out.join("")).toContain(
      '       step 3: Running expected "false" got true (in quotes "false" is text: write false without them)\n       step 3: Count expected "3" got 2 (in quotes "3" is text: write 3 without them)\n',
    );
  });

  it("test prints once per file what the stubs stood in for, and a stub the cases never called", async () => {
    const t = setup();
    const blocks = join(t.dir, "plc", "PLC_1", "blocks");
    mkdirSync(blocks, { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(blocks, "Fx_Scale.scl"), 'FUNCTION_BLOCK "Fx_Scale"\n   VAR_INPUT\n      x : Int;\n   END_VAR\n   VAR_OUTPUT\n      y : Int;\n   END_VAR\nBEGIN\n   #y := #x * 2;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(blocks, "Fx_Reader.scl"), 'FUNCTION_BLOCK "Fx_Reader"\n   VAR_OUTPUT\n      ok : Bool;\n      scaled : Int;\n   END_VAR\n   VAR\n      rd : RDREC;\n      sc : "Fx_Scale";\n      mb : MB_CLIENT;\n   END_VAR\nBEGIN\n   #rd(REQ := TRUE, ID := 256, INDEX := 1);\n   #ok := #rd.VALID;\n   #sc(x := 3, y => #scaled);\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "reader.test.yaml"), "block: Fx_Reader\nstubs:\n  RDREC: { VALID: true }\n  Fx_Scale: { y: 5 }\n  MB_CLIENT: {}\ncases:\n  - name: reads\n    steps:\n      - cycle: 2\n      - expect: { ok: true, scaled: 5 }\n");
    expect(await t.run("test")).toBe(0);
    expect(t.out.join("")).toContain(
      "ok   Fx_Reader: reads\n       stubbed: RDREC ×2, Fx_Scale ×2 (replaces code the simulator runs)\n       warning: stub MB_CLIENT was never called: a typo, or code these cases do not reach\n",
    );
  });

  it("test says which name a misspelt one most likely meant", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Fx_Run.scl"), 'FUNCTION_BLOCK "Fx_Run"\n   VAR_INPUT\n      Start : Bool;\n   END_VAR\n   VAR_OUTPUT\n      Running : Bool;\n   END_VAR\nBEGIN\n   #Running := #Start;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "run.test.yaml"), "block: Fx_Run\ncases:\n  - name: runs\n    steps:\n      - cycle: 1\n      - expect: { Runing: false }\n");
    writeFileSync(join(t.dir, "tests", "typo.test.yaml"), "block: Fx_Rn\ncases:\n  - name: runs\n    steps:\n      - cycle: 1\n");
    expect(await t.run("test")).toBe(2);
    expect(t.out.join("")).toContain("FAIL tests/run.test.yaml:3 Fx_Run: runs — step 2: Runing does not exist (did you mean Running?)\n");
    expect(t.out.join("")).toContain("FAIL tests/typo.test.yaml: block Fx_Rn not found (did you mean Fx_Run?)\n");
  });

  it("test --json gives editors every result with the line of its case and failing step", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Fx_Run.scl"), 'FUNCTION_BLOCK "Fx_Run"\n   VAR_INPUT\n      Start : Bool;\n   END_VAR\n   VAR_OUTPUT\n      Running : Bool;\n   END_VAR\nBEGIN\n   #Running := #Start;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "run.test.yaml"), "block: Fx_Run\ncases:\n  - name: starts\n    steps:\n      - { set: { Start: true }, cycle: 1, expect: { Running: true } }\n  - name: stops\n    steps:\n      - set: { Start: false }\n      - cycle: 1\n      - expect: { Running: true }\n  - name: bad set\n    steps:\n      - cycle: 1\n      - set: { Strat: true }\n");
    expect(await t.run("test", "--json")).toBe(2);
    const r = JSON.parse(t.out.join("")) as { files: { file: string; cases: { name: string; passed: boolean; line: number; failures: { step: number; line: number }[]; errorStep?: number; errorLine?: number }[] }[] };
    expect(r.files.map((f) => [f.file, f.cases.map((c) => [c.name, c.passed, c.line, c.failures.map((x) => [x.step, x.line])])])).toEqual([
      ["tests/run.test.yaml", [["starts", true, 3, []], ["stops", false, 6, [[3, 10]]], ["bad set", false, 11, []]]],
    ]);
    // a case that stops with an error names the step it stopped in, and that step's line
    expect(r.files[0]!.cases[2]).toMatchObject({ errorStep: 2, errorLine: 14 });
    expect(r.files[0]!.cases[0]).not.toHaveProperty("errorStep");
  });

  it("every failed case identifies its file and case line, including execution errors", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Fx_Run.scl"), 'FUNCTION_BLOCK "Fx_Run"\nVAR_OUTPUT\n  Running : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "first.test.yaml"), "block: Fx_Run\ncases:\n  - name: runs\n    steps:\n      - expect: { Running: true }\n");
    writeFileSync(join(t.dir, "tests", "second.test.yaml"), "block: Fx_Run\n\ncases:\n  - name: runs\n    steps:\n      - set: { Typo: true }\n");
    expect(await t.run("test")).toBe(2);
    expect(t.out.join("")).toContain("FAIL tests/first.test.yaml:3 Fx_Run: runs");
    expect(t.out.join("")).toContain("FAIL tests/second.test.yaml:4 Fx_Run: runs — step 1:");
  });

  it("no matching tests has a distinct exit code in both text and JSON", async () => {
    const t = setup();
    expect(await t.run("test", "--filter", "Plant_DB")).toBe(3);
    expect(t.out.join("")).toContain('no tests match "Plant_DB"');
    t.out.length = 0;
    expect(await t.run("test", "--filter", "Plant_DB", "--json")).toBe(3);
    expect(JSON.parse(t.out.join(""))).toEqual({ files: [] });
  });

  it("test in GitHub Actions puts every failure on its step in the pull request", async () => {
    const t = setup({ GITHUB_ACTIONS: "true" });
    mkdirSync(join(t.dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(t.dir, "tests"), { recursive: true });
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Fx_Run.scl"), 'FUNCTION_BLOCK "Fx_Run"\n   VAR_INPUT\n      Start : Bool;\n   END_VAR\n   VAR_OUTPUT\n      Running : Bool;\n   END_VAR\nBEGIN\n   #Running := #Start;\nEND_FUNCTION_BLOCK\n');
    writeFileSync(join(t.dir, "tests", "run.test.yaml"), "block: Fx_Run\ncases:\n  - name: stops, then\n    steps:\n      - set: { Start: false }\n      - { cycle: 1, expect: { Running: true } }\n  - name: typo\n    steps:\n      - cycle: 1\n      - set: { Strat: true }\n");
    expect(await t.run("test")).toBe(2);
    expect(t.out.join("")).toContain("::error file=tests/run.test.yaml,line=6,title=rung test%3A Fx_Run%3A stops%2C then::step 2: Running expected true got false\n");
    expect(t.out.join("")).toContain("::error file=tests/run.test.yaml,line=10,title=rung test%3A Fx_Run%3A typo::step 2: Strat does not exist (did you mean Start?)\n");
  });

  it("test says so when there are no tests instead of 0/0 passed", async () => {
    const t = setup();
    expect(await t.run("test")).toBe(3);
    expect(t.out.join("")).toMatch(/^no tests: rung test runs tests\/\*\*\/\*\.test\.yaml/);
    // a test file without .test in its name is read by nobody: say which
    mkdirSync(join(t.dir, "tests", "drives"), { recursive: true });
    writeFileSync(join(t.dir, "tests", "drives", "motor.yaml"), "block: Fx_Motor\n");
    t.out.length = 0;
    expect(await t.run("test")).toBe(3);
    expect(t.out.join("")).toBe("no tests: rung test runs tests/**/*.test.yaml (docs/testing.md); tests/drives/motor.yaml is not named *.test.yaml\n");
  });

  it("init --tia must match the TIA Portal that has the project open", async () => {
    const t = setup();
    expect(await t.run("init", "--tia", "V21")).toBe(1);
    expect(t.err.join("")).toMatch(/BAD_ARGUMENT: --tia V21 does not match: .*RungFixture\.ap20 is open in TIA Portal V20/);
    expect(existsSync(join(t.dir, "rung.toml"))).toBe(false);
  });

  it("init with --project fails clearly when that project is not open", async () => {
    const t = setup();
    expect(await t.run("init", "--project", "C:\\nope\\Nope.ap20")).toBe(1);
    expect(t.err.join("")).toMatch(/NO_PROJECT/);
    // no rung.toml yet: the hint is about the path, not about rung.toml
    expect(t.err.join("")).toMatch(/\nhint: Check the path: --project is the project file \(\.ap20\) with its full path\.\n$/);
  });

  it("init without --project and no project open in TIA Portal says to name it", async () => {
    const t = setup({ FAKE_NO_PROJECT: "1" });
    expect(await t.run("init")).toBe(1);
    expect(t.err.join("")).toBe(
      "rung: NO_PROJECT: No TIA Portal instance has a project open.\nhint: Open the project in TIA Portal, or name it: rung init --project <path to the .ap20> (rung then opens it in a TIA Portal without window).\n",
    );
  });

  it("pull while rung watch runs says it is not needed, and a locked workspace starts no bridge", async () => {
    const t = setup();
    await t.run("init");
    await t.run("pull");
    t.err.length = 0;
    const starts = () => (JSON.parse(readFileSync(t.objects, "utf8")) as { starts?: number }).starts ?? 0;
    const before = starts();
    const owner = await OwnerServer.start(t.dir, {});
    try {
      expect(await t.run("pull")).toBe(1);
      expect(t.err.join("")).toBe("rung: rung watch runs in this workspace and already brings TIA Portal's changes in; rung pull is not needed while it runs (Ctrl+C there stops it)\n");
    } finally {
      await owner.close();
    }
    // another rung process holds the workspace: fail at once, before TIA Portal is involved
    const lock = await StateStore.open(t.dir, null);
    try {
      for (const cmd of [["pull"], ["sync"], ["confirm-delete", "plc/PLC_1/blocks/Motor%2FValve 1.scl"]]) {
        t.err.length = 0;
        expect(await t.run(...cmd)).toBe(1);
        // confirm-delete is refused earlier still: writes are off in this workspace
        expect(t.err.join("")).toMatch(cmd[0] === "confirm-delete" ? /^rung: WRITES_OFF: / : /^rung: STATE_LOCKED: /);
      }
    } finally {
      await lock.close();
    }
    expect(starts()).toBe(before);
  });

  it("pull mirrors the project and a second pull is a no-op", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("pull")).toBe(0);
    expect(readFileSync(join(t.dir, "plc", "PLC_1", "blocks", "10_Drives", "Motors", "Fx_Motor.scl"), "utf8")).toBe('FUNCTION_BLOCK "Fx_Motor"\nEND_FUNCTION_BLOCK\n');
    expect(t.out.join("")).toMatch(/exported\s+2/);
    t.out.length = 0;
    expect(await t.run("pull")).toBe(0);
    expect(t.out.join("")).toMatch(/unchanged\s+2/);
  });

  it("a bridge for init, pull or sync never inherits the right to download, from rung's environment or the process's", async () => {
    const seen = join(tmpdir(), `rung-env-${Date.now()}-${Math.random()}.json`);
    const t = setup({ FAKE_ENV_OUT: seen, RUNG_CODESYS_ALLOW_DOWNLOAD: "1" });
    const before = process.env.RUNG_CODESYS_ALLOW_DOWNLOAD;
    process.env.RUNG_CODESYS_ALLOW_DOWNLOAD = "1"; // BridgeClient puts the given environment over the process's
    try {
      for (const cmd of ["init", "pull", "sync"]) {
        await t.run(cmd);
        expect([cmd, (JSON.parse(readFileSync(seen, "utf8")) as { allowDownload: string | null }).allowDownload]).toEqual([cmd, ""]);
      }
    } finally {
      if (before === undefined) delete process.env.RUNG_CODESYS_ALLOW_DOWNLOAD;
      else process.env.RUNG_CODESYS_ALLOW_DOWNLOAD = before;
    }
  });

  it("keeps working after a PLC is added to the project (devices = all)", async () => {
    const t = setup();
    await t.run("init");
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    db.project.devices.push("PLC_2");
    writeFileSync(t.objects, JSON.stringify(db));
    expect(await t.run("pull")).toBe(0);
  });

  it("init --rebind keeps the user's sync settings", async () => {
    const t = setup();
    await t.run("init");
    const cfg = join(t.dir, "rung.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("pollMs = 2000", "pollMs = 5000"));
    expect(await t.run("init", "--rebind")).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain("pollMs = 5000");
  });

  it("pull exits 2 when there are warnings", async () => {
    const t = setup();
    await t.run("init");
    await t.run("pull");
    writeFileSync(join(t.dir, "plc", "PLC_1", "blocks", "Motor%2FValve 1.scl"), "// my edit\n");
    expect(await t.run("pull")).toBe(2);
    expect(t.out.join("")).toMatch(/LOCAL_CHANGES/);
  });

  it("explains ACCESS_DENIED", async () => {
    const t = setup();
    await t.run("init");
    const denied = setup({ FAKE_ACCESS_DENIED: "1" });
    writeFileSync(join(denied.dir, "rung.toml"), readFileSync(join(t.dir, "rung.toml")));
    expect(await denied.run("pull")).toBe(1);
    expect(denied.err.join("")).toMatch(/Siemens TIA Openness/);
  });

  it("pull outside a workspace fails with a hint", async () => {
    const t = setup();
    expect(await t.run("pull")).toBe(1);
    expect(t.err.join("")).toMatch(/rung init/);
  });

  it("doctor requires --fixture", async () => {
    const t = setup();
    await t.run("init");
    expect(await t.run("doctor")).toBe(1);
    expect(t.err.join("")).toMatch(/--fixture/);
    expect(await t.run("doctor", "--fixture")).toBe(0);
    expect(t.out.join("")).toMatch(/scl/);
  });

  it("status lists objects needing attention", async () => {
    const t = setup();
    await t.run("init");
    await t.run("pull");
    expect(await t.run("status")).toBe(0);
    expect(t.out.join("")).toMatch(/2 objects, 2 synced/);
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    writeFileSync(t.objects, JSON.stringify({ ...db, objects: db.objects.slice(0, 1) }));
    await t.run("pull");
    t.out.length = 0;
    await t.run("status");
    expect(t.out.join("")).toMatch(/^writes to TIA Portal: off \(rung writes on\)\n1 object, 1 synced\n/);
  });

  it("status counts a read-only object among the objects, not beside them", async () => {
    const t = setup();
    await t.run("init");
    const db = JSON.parse(readFileSync(t.objects, "utf8"));
    const o = db.objects[0];
    o.entry = { address: o.address, kind: "block", language: "SCL", knowHowProtected: false, isFailsafe: true, isSystem: false, fingerprint: "fp:safe" };
    writeFileSync(t.objects, JSON.stringify(db));
    await t.run("pull");
    t.out.length = 0;
    await t.run("status");
    expect(t.out.join("")).toContain("2 objects, 2 synced; 1 of the 2 read-only (rung never changes it in TIA Portal)\n");
  });
});
