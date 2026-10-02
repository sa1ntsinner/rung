// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../../packages/cli/src/main.js";
import { liveReader, type LiveReader } from "../../packages/cli/src/live.js";
import { createCodesysFixture, codesysWorkspace, sleep } from "./codesys-helpers.js";
import { corpus, corpusDir, normalizeValue, readRecording, recording, serializeRecording, type RecordedValue } from "../../packages/sim/test/conformance-helpers.js";

const enabled = process.env.RUNG_E2E_CODESYS === "1";
const record = process.env.RUNG_CONFORMANCE_RECORD === "1";

describe.runIf(enabled)("e2e: CODESYS conformance", () => {
  it(record ? "records CODESYS results" : "compares CODESYS with the recordings", async () => {
    const { sources } = await corpus();
    const previous = new Map<string, Record<string, RecordedValue>>();
    if (!record) {
      const missing: string[] = [];
      for (const source of sources) {
        const saved = await readRecording(source);
        if (saved) previous.set(source.block, saved.spec.cases[0].steps[1].expect);
        else missing.push(source.file);
      }
      if (missing.length) throw new Error("not recorded: " + missing.join(", ") + "; set RUNG_CONFORMANCE_RECORD=1 to record CODESYS first");
    }
    const base = mkdtempSync(join(tmpdir(), "rung-conformance-cds-"));
    const project = join(base, "fixture", "RungCds.project");
    const dir = join(base, "ws");
    mkdirSync(dir, { recursive: true });
    createCodesysFixture(project);
    const { io, run, file } = codesysWorkspace(dir);
    const checked = async (...args: string[]) => {
      const result = await run(...args);
      expect(result.code, result.text).toBe(0);
      return result.text;
    };
    await checked("init", "--project", project, "--writes");
    const pulled = await run("pull");
    expect([0, 2], pulled.text).toContain(pulled.code);
    const blocks = file("plc/Device/blocks/Conformance");
    const types = file("plc/Device/types/Conformance");
    mkdirSync(blocks, { recursive: true });
    mkdirSync(types, { recursive: true });
    for (const source of sources) await writeFile(join(blocks, source.block + ".st"), source.text);
    for (const name of (await readdir(join(corpusDir, "support"))).filter((n) => n.endsWith(".st")).sort()) {
      const text = await readFile(join(corpusDir, "support", name), "utf8");
      await writeFile(join(/^TYPE\s/m.test(text) ? types : blocks, name), text);
    }
    // A task calls only PLC_PRG; uncalled POUs would never be compiled or executed by CODESYS.
    await writeFile(file("plc/Device/blocks/PLC_PRG.st"), "PROGRAM PLC_PRG\nVAR\nEND_VAR\n" + sources.map((s) => s.block + "();").join("\n") + "\nEND_PROGRAM\n");
    expect(await checked("sync")).toMatch(/Compile complete -- 0 errors/);
    await checked("connect", "--use", "CODESYS simulation", "--mode", "simulation");

    let stopWatch!: () => void;
    let watchEnded = false;
    const watchOut: string[] = [];
    const watching = main(["watch"], { ...io, stdout: (s) => watchOut.push(s), stderr: (s) => watchOut.push(s), stopSignal: new Promise<void>((resolve) => (stopWatch = resolve)) });
    void watching.then(() => (watchEnded = true), () => (watchEnded = true));
    let reader: LiveReader | undefined;
    try {
      const readyBy = Date.now() + 120_000;
      while (!existsSync(file(".rung/owner.json"))) {
        if (watchEnded || Date.now() >= readyBy) throw new Error("watch did not start:\n" + watchOut.join(""));
        await sleep(500);
      }
      let downloaded = await run("download", "--yes");
      while (/NOT_READY/.test(downloaded.text) && Date.now() < readyBy && !watchEnded) {
        await sleep(1000);
        downloaded = await run("download", "--yes");
      }
      expect(downloaded.code, downloaded.text).toBe(0);
      expect(downloaded.text).toMatch(/download: Success/);
      reader = await liveReader(pathToFileURL(join(blocks, sources[0]!.block + ".st")).href, io, dir);
      const doneNames = sources.map((s) => s.block + ".done");
      const doneBy = Date.now() + 120_000;
      while (true) {
        const rows = await reader.read(doneNames);
        if (rows.length !== doneNames.length) throw new Error("plc.read returned an incomplete done list");
        if (rows.some((r, i) => r.error || r.name !== doneNames[i])) throw new Error(JSON.stringify(rows));
        if (rows.every((r) => normalizeValue(r.value, "BOOL") === true)) break;
        if (watchEnded || Date.now() >= doneBy) throw new Error("programs did not finish: " + JSON.stringify(rows));
        await sleep(250);
      }
      const recordings = [];
      const differences: string[] = [];
      for (const source of sources) {
        const vars = [{ name: "done", type: "BOOL" }, { name: "cycle", type: "UINT" }, ...source.results];
        const expressions = vars.map((v) => /^(?:LINT|ULINT|LWORD)$/.test(v.type) ? v.type + "_TO_STRING(" + source.block + "." + v.name + ")" : source.block + "." + v.name);
        const rows = await reader.read(expressions);
        if (rows.length !== vars.length) throw new Error(source.file + ": plc.read returned an incomplete result list");
        const values: Record<string, RecordedValue> = {};
        for (const [i, v] of vars.entries()) {
          const row = rows[i]!;
          if (row.name !== expressions[i] || row.error || row.value === undefined || row.value === null) throw new Error(source.file + ": unreadable result " + v.name + ": " + JSON.stringify(row));
          values[v.name] = normalizeValue(row.value, v.type);
        }
        const spec = recording(source, values);
        recordings.push({ source, spec });
        if (!record) {
          const expected = previous.get(source.block)!;
          for (const v of vars) if (values[v.name] !== expected[v.name]) differences.push(source.file + ": " + v.name + " expected " + JSON.stringify(expected[v.name]) + ", CODESYS gave " + JSON.stringify(values[v.name]));
        }
      }
      // Read and validate the entire application before replacing any baseline.
      if (record) {
        for (const { source, spec } of recordings) await writeFile(join(corpusDir, source.file.replace(/\.st$/, ".test.yaml")), serializeRecording(spec));
        console.log("recorded " + recordings.length + " programs from CODESYS");
      } else expect(differences, differences.join("\n")).toEqual([]);
    } catch (e) {
      console.log("rung watch said:\n" + watchOut.join(""));
      throw e;
    } finally {
      try {
        await reader?.close();
      } finally {
        stopWatch();
        await watching;
      }
    }
  }, 900_000);
});
