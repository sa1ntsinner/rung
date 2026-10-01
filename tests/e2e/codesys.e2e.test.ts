// SPDX-License-Identifier: BUSL-1.1
// End-to-end against a real CODESYS (no window), on a fixture project it generates itself: init, pull, an edit,
// a new FB in a folder, compile errors on their lines, and a download into CODESYS's own simulation.
//   RUNG_E2E_CODESYS=1 pnpm vitest run tests/e2e/codesys.e2e.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../packages/cli/src/main.js";
import { findCodesys } from "../../packages/cli/src/codesys.js";

const enabled = process.env.RUNG_E2E_CODESYS === "1";
const repo = fileURLToPath(new URL("../..", import.meta.url));

describe.runIf(enabled)("e2e: CODESYS", () => {
  const base = enabled ? mkdtempSync(join(tmpdir(), "rung-e2e-cds-")) : "";
  const project = join(base, "fixture", "RungCds.project");
  const dir = join(base, "ws");
  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const run = async (...args: string[]) => {
    out.length = 0;
    const code = await main(args, io);
    return { code, text: out.join("") };
  };
  const file = (rel: string) => join(dir, ...rel.split("/"));

  beforeAll(() => {
    const cds = findCodesys();
    if (!cds) throw new Error("CODESYS is not installed");
    mkdirSync(dir, { recursive: true });
    const r = spawnSync(cds.exe, [`--profile="${cds.profile}"`, "--noUI", `--runscript="${join(repo, "tools", "fixtures", "codesys", "new_fixture.py")}"`], {
      env: { ...process.env, RUNG_CODESYS_FIXTURE: project },
      windowsVerbatimArguments: true,
      windowsHide: true,
      timeout: 300_000,
    });
    const log = existsSync(project + ".log") ? readFileSync(project + ".log", "utf8") : `(no log; exit ${r.status})`;
    if (!/^ok/.test(log)) throw new Error(`fixture generation failed:\n${log}`);
  }, 360_000);

  it("init and pull mirror POUs with their methods, DUTs and GVLs as .st files", async () => {
    expect((await run("init", "--project", project, "--writes")).code).toBe(0);
    expect(readFileSync(file("rung.toml"), "utf8")).toContain('tiaVersion = "CODESYS"');
    expect([0, 2]).toContain((await run("pull")).code);
    expect(readFileSync(file("plc/Device/blocks/Motion/FB_Count.st"), "utf8")).toBe(
      "FUNCTION_BLOCK FB_Count\nVAR_INPUT\n\tbOn : BOOL;\nEND_VAR\nVAR_OUTPUT\n\tnCount : INT;\nEND_VAR\nIF bOn THEN\n\tnCount := nCount + 1;\nEND_IF\nEND_FUNCTION_BLOCK\n\nMETHOD Reset : BOOL\nnCount := 0;\nReset := TRUE;\nEND_METHOD\n",
    );
    expect(readFileSync(file("plc/Device/types/ST_Axis.st"), "utf8")).toContain("TYPE ST_Axis :");
    expect(readFileSync(file("plc/Device/tags/GVL_Plant.st"), "utf8")).toContain("VAR_GLOBAL");
  }, 600_000);

  it("rung views shows the library manager: libraries, placeholders and their versions", async () => {
    const r = await run("views");
    expect(r.code).toBe(0);
    const dir = file("views/libraries");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const text = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(text).toMatch(/type: LibraryManager/);
    expect(text).toMatch(/type: (Library|Placeholder)/);
    expect(text).toMatch(/Standard/);
  }, 600_000);

  it("an edit, a new method and a new FB in a new folder go into CODESYS; then quiet", async () => {
    const fb = file("plc/Device/blocks/Motion/FB_Count.st");
    writeFileSync(fb, readFileSync(fb, "utf8").replace("nCount + 1", "nCount + 2") + "\nMETHOD Double : INT\nDouble := nCount * 2;\nEND_METHOD\n");
    mkdirSync(file("plc/Device/blocks/Lights"), { recursive: true });
    writeFileSync(file("plc/Device/blocks/Lights/FB_Lamp.st"), "FUNCTION_BLOCK FB_Lamp\nVAR_INPUT\n\tbOn : BOOL;\nEND_VAR\nVAR_OUTPUT\n\tbLit : BOOL;\nEND_VAR\nbLit := bOn;\nEND_FUNCTION_BLOCK\n");
    const r = await run("sync");
    expect(r.text).toMatch(/imported 1\s+created 1/);
    expect(r.text).toMatch(/Compile complete -- 0 errors/);
    expect(readFileSync(fb, "utf8")).toContain("METHOD Double : INT");
    const idle = await run("sync");
    expect(idle.text).toMatch(/exported 0\s+imported 0\s+created 0/);
  }, 600_000);

  it("a PROPERTY with GET and SET goes into CODESYS; without SET it is read-only; SET comes back", async () => {
    const lamp = file("plc/Device/blocks/Lights/FB_Lamp.st");
    const prop = (set: boolean) =>
      "\nPROPERTY Brightness : INT\nGET\nVAR\nEND_VAR\nBrightness := SEL(bLit, 0, 100);\nEND_GET\n" + (set ? "SET\nVAR\nEND_VAR\nbOn := Brightness > 0;\nEND_SET\n" : "") + "END_PROPERTY\n";
    const base = readFileSync(lamp, "utf8");
    writeFileSync(lamp, base + prop(true));
    let r = await run("sync");
    expect(r.text).toMatch(/imported 1/);
    expect(r.text).toMatch(/Compile complete -- 0 errors/);
    const back = readFileSync(lamp, "utf8");
    expect(back).toContain("PROPERTY Brightness : INT\nGET\n");
    expect(back).toContain("bOn := Brightness > 0;\nEND_SET\nEND_PROPERTY\n");
    // read-only: no SET
    writeFileSync(lamp, back.replace(/SET\nVAR\nEND_VAR\nbOn := Brightness > 0;\nEND_SET\n/, ""));
    r = await run("sync");
    expect(r.text).toMatch(/imported 1/);
    expect(readFileSync(lamp, "utf8")).not.toContain("END_SET");
    // SET again: CODESYS rebuilds the property with both accessors
    writeFileSync(lamp, readFileSync(lamp, "utf8").replace("END_GET\nEND_PROPERTY", "END_GET\nSET\nVAR\nEND_VAR\nbOn := Brightness > 0;\nEND_SET\nEND_PROPERTY"));
    r = await run("sync");
    expect(r.text).toMatch(/imported 1/);
    expect(r.text).toMatch(/Compile complete -- 0 errors/);
    expect(readFileSync(lamp, "utf8")).toContain("bOn := Brightness > 0;\nEND_SET\nEND_PROPERTY\n");
    const idle = await run("sync");
    expect(idle.text).toMatch(/exported 0\s+imported 0\s+created 0/);
  }, 600_000);

  it("a compile error points at its line in the file", async () => {
    const prg = file("plc/Device/blocks/PLC_PRG.st");
    const before = readFileSync(prg, "utf8");
    writeFileSync(prg, before.replace("fbCount(bOn := TRUE);", "fbCount(bOn := TRUE);\nnMissing := 1;"));
    const r = await run("sync");
    const line = readFileSync(prg, "utf8").split("\n").findIndex((l) => l.includes("nMissing")) + 1;
    expect(r.text).toContain(`plc/Device/blocks/PLC_PRG.st:${line} — Identifier 'nMissing' not defined`);
    writeFileSync(prg, before);
    expect((await run("sync")).text).toMatch(/Compile complete -- 0 errors/);
  }, 600_000);

  it("downloads into CODESYS's simulation as an online change", async () => {
    expect((await run("connect", "--use", "CODESYS simulation", "--mode", "simulation")).code).toBe(0);
    const dl = await run("download", "--yes");
    expect(dl.text).toMatch(/online-change/);
    expect(dl.text).toMatch(/download: Success/);
    expect(dl.code).toBe(0);
  }, 600_000);

  it("monitors an FB while rung watch runs: the simulation lives in the bridge's CODESYS", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let stopWatch!: () => void;
    const watchOut: string[] = [];
    const watching = main(["watch"], { ...io, stdout: (s) => watchOut.push(s), stderr: (s) => watchOut.push(s), stopSignal: new Promise<void>((r) => (stopWatch = r)) });
    let dlText = "";
    try {
      // a download through the watch (until its bridge is up it answers NOT_READY)
      for (let i = 0; i < 60 && !existsSync(file(".rung/owner.json")); i++) await sleep(500);
      let dl = await run("download", "--yes");
      for (let i = 0; i < 60 && /NOT_READY/.test(dl.text); i++) {
        await sleep(2000);
        dl = await run("download", "--yes");
      }
      dlText = dl.text;
      expect(dl.text).toMatch(/download: Success/);
      const lines: string[] = [];
      let stopLive!: () => void;
      const live = main(["live", "watch", "--json", "--file", "plc/Device/blocks/Motion/FB_Count.st", "--interval", "500"], {
        ...io,
        stdout: (s) => lines.push(...s.split("\n").filter(Boolean)),
        stopSignal: new Promise<void>((r) => (stopLive = r)),
      });
      for (let i = 0; i < 60 && lines.filter((l) => l.includes('"values"')).length < 3; i++) await sleep(500);
      stopLive();
      expect(await live).toBe(0);
      const [first, ...reads] = lines.map((l) => JSON.parse(l) as { plan?: { instance: string }; values?: { nCount: number; bOn: boolean } });
      expect(first!.plan!.instance).toBe("PLC_PRG.fbCount"); // found by itself: the one PROGRAM variable of this type
      const counts = reads.map((r) => r.values!.nCount);
      expect(counts.at(-1)!).toBeGreaterThan(counts[0]!); // it runs
      expect(reads.at(-1)!.values!.bOn).toBe(true);
    } catch (e) {
      console.log(`rung download said:\n${dlText}\nrung watch said:\n${watchOut.join("")}`);
      throw e;
    } finally {
      stopWatch();
      await watching;
    }
  }, 900_000);
});
