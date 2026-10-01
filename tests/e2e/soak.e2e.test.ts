// SPDX-License-Identifier: BUSL-1.1
// Randomized two-way soak against the fixture project in a real TIA Portal. One person edits files, another
// edits the same blocks in TIA Portal (a second Openness client), rung sync runs after every step and is
// killed at random moments (Ctrl+C, a crash). Nothing typed on either side may get lost, no conflict may
// appear (the two people never touch the same line), and the workspace ends quiet and equal to TIA Portal.
//   RUNG_E2E_SOAK=1 [RUNG_SOAK_MINUTES=30] [RUNG_SOAK_SEED=1] [RUNG_SOAK_UNIT=Fx_Unit] [RUNG_SOAK_KIND=tags|db] [RUNG_SOAK_WATCH=1] pnpm vitest run tests/e2e/soak.e2e.test.ts
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeError } from "../../packages/bridge-client/src/index.js";

const enabled = process.env.RUNG_E2E_SOAK === "1";
const minutes = Number(process.env.RUNG_SOAK_MINUTES ?? 30);
const seed = Number(process.env.RUNG_SOAK_SEED ?? 1);
const project = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(repo, "packages", "cli", "dist", "index.js");
const bridgeExe = join(repo, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48", "rung-bridge-v20.exe");

const NAMES = ["A", "B", "C", "D", "E", "F"];
// RUNG_SOAK_UNIT=Fx_Unit runs it in a software unit of the fixture. RUNG_SOAK_KIND: scl (SCL blocks, the default),
// tags (tag tables as .tags.st, the two people editing the comments of two tags) or db (global DBs, the start values
// of two members)
const kind = process.env.RUNG_SOAK_KIND ?? "scl";
const tags = kind === "tags";
const watchMode = process.env.RUNG_SOAK_WATCH === "1";
const db = kind === "db";
const folder = `PLC_1/${process.env.RUNG_SOAK_UNIT ? `units/${process.env.RUNG_SOAK_UNIT}/` : ""}${tags ? "tags" : "blocks"}/90_Soak`;
const leaf = (n: string) => (tags ? `Fx_SoakTags_${n}` : db ? `Fx_SoakDb_${n}` : `Fx_Soak_${n}`);
const form = tags ? "tags.st" : db ? "db" : "scl";
const addr = (n: string) => `plc:${folder}/${leaf(n)}`;
const rel = (n: string) => `plc/${folder}/${leaf(n)}.${form}`;
// the file person writes line 1, the person in TIA Portal line 4. A DB's start values are written as TIA Portal
// writes them: after BEGIN, not in the declaration, and a value equal to the default not at all (so none is 0)
const line = (n: string, which: 1 | 4, v: number) =>
  tags ? `Soak_${n}_${which} AT %M${200 + NAMES.indexOf(n)}.${which - 1} : Bool;  // ${v}` : db ? `v${which} := ${v};` : `#l${which} := ${v};`;
const lineAt = (n: string, which: 1 | 4) =>
  tags ? new RegExp(`Soak_${n}_${which} AT %M\\d+\\.\\d : Bool;(  // -?\\d+)?`) : db ? new RegExp(`v${which} := -?\\d+;`) : new RegExp(`#l${which} := -?\\d+;`);
const START4 = db ? 7 : 0;
const source = (n: string, l1: number) =>
  tags
    ? `VAR_GLOBAL\n    ${line(n, 1, l1)}\n    Soak_${n}_2 AT %M${200 + NAMES.indexOf(n)}.1 : Bool;\n    Soak_${n}_3 AT %M${200 + NAMES.indexOf(n)}.2 : Bool;\n    ${line(n, 4, START4)}\nEND_VAR\n`
    : db
      ? `DATA_BLOCK "${leaf(n)}"\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\nNON_RETAIN\n   VAR \n      v1 : Int;\n      v2 : Int;\n      v3 : Int;\n      v4 : Int;\n   END_VAR\n\n\nBEGIN\n   ${line(n, 1, l1)}\n   v2 := 2;\n   v3 := 3;\n   ${line(n, 4, START4)}\n\nEND_DATA_BLOCK\n`
      : `FUNCTION "Fx_Soak_${n}" : Void\n{ S7_Optimized_Access := 'TRUE' }\nVERSION : 0.1\n   VAR_TEMP \n      l1 : Int;\n      l2 : Int;\n      l3 : Int;\n      l4 : Int;\n   END_VAR\n\n\nBEGIN\n\t#l1 := ${l1};\n\t#l2 := 2;\n\t#l3 := 3;\n\t#l4 := ${START4};\nEND_FUNCTION\n`;
// lines 2 and 3 keep the two people's lines apart: a line merge, like git's, joins changes on neighbouring lines
const counts = (out: string) => {
  const m = /exported (\d+)\s+imported (\d+)\s+created (\d+)\s+merged (\d+)\s+conflicts (\d+)/.exec(out);
  return m ? { exported: +m[1]!, imported: +m[2]!, created: +m[3]!, merged: +m[4]!, conflicts: +m[5]! } : undefined;
};

function rng(s: number) {
  let x = s >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe.runIf(enabled)("soak: real TIA Portal, two people, killed syncs", () => {
  it(`${minutes} minutes stay consistent and lose nothing`, async () => {
    const rand = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const ws = mkdtempSync(join(tmpdir(), "rung-soak-"));
    const logFile = join(ws, "soak.log");
    const log = (s: string) => appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
    console.log(`soak workspace ${ws} (log: ${logFile}), seed ${seed}, ${minutes} min`);

    const run = (args: string[], killAfterMs?: number) =>
      new Promise<{ code: number | null; out: string; killed: boolean }>((done) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd: ws, windowsHide: true, env: { ...process.env, RUNG_DEBUG: "" } });
        let out = "";
        let killed = false;
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const kill = () => {
          killed = true;
          spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }); // like closing the terminal
        };
        const killer = killAfterMs !== undefined ? setTimeout(kill, killAfterMs) : undefined;
        const hang = setTimeout(() => {
          out += "\n[soak: no answer after 5 minutes]";
          kill();
        }, 300_000);
        child.on("close", (code) => {
          clearTimeout(killer);
          clearTimeout(hang);
          done({ code, out, killed });
        });
      });

    // RUNG_SOAK_WATCH=1: rung watch runs all the time and each sync goes to it (as an editor's does); a kill stops rung
    // watch itself, which then starts again
    let watcher: ReturnType<typeof spawn> | undefined;
    const startWatch = async () => {
      const w = spawn(process.execPath, [cli, "watch"], { cwd: ws, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUNG_DEBUG: "" } });
      watcher = w;
      let said = "";
      w.stdout?.on("data", (d) => (said = (said + d).slice(-4000)));
      w.stderr?.on("data", (d) => (said = (said + d).slice(-4000)));
      // a watch that stops by itself would leave the soak running one-shot syncs: that is a problem, not a pass
      w.on("exit", (code) => {
        if (watcher !== w) return;
        watcher = undefined;
        problems.push(`rung watch exited by itself (code ${code})\n${said}`);
      });
      // ready once it owns the workspace (an owner file of a watch killed before names a dead process)
      const ownerFile = join(ws, ".rung", "owner.json");
      for (let i = 0; i < 1200; i++) {
        try {
          if ((JSON.parse(readFileSync(ownerFile, "utf8")) as { pid?: number }).pid === w.pid) return;
        } catch {
          // not there yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("rung watch did not start within 2 minutes");
    };
    const killWatch = () => {
      if (watcher?.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(watcher.pid)], { windowsHide: true });
      watcher = undefined;
    };

    // the other person, in TIA Portal
    const user = await BridgeClient.spawn({ command: bridgeExe, args: ["--project", project, "--allow-fixture-import"] });
    const problems: string[] = [];
    const exists = new Map<string, boolean>();
    const l1 = new Map<string, number>();
    const l4 = new Map<string, number>();
    let counter = 1;
    try {
      // leftovers of an earlier run
      for (const e of await user.listObjects("PLC_1"))
        if (e.address.startsWith(`plc:${folder}/`)) await user.deleteObject(e.address, e.fingerprint, randomUUID());

      expect((await run(["init", "--project", project, "--writes"])).code).toBe(0);
      expect([0, 2]).toContain((await run(["pull"])).code);
      if (watchMode) await startWatch();

      const tiaEdit = async (n: string, v: number): Promise<boolean> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          // a create that a kill interrupted reaches TIA Portal only with the next sync
          if (!(await user.listObjects("PLC_1")).some((e) => e.address === addr(n))) return false;
          let r;
          try {
            r = await user.exportObject(addr(n), "auto", mkdtempSync(join(tmpdir(), "rung-soak-tia-")));
          } catch (e) {
            // an import replaces the block: for a moment the other Openness client finds none
            if (e instanceof BridgeError && e.code === "NOT_FOUND") continue;
            throw e;
          }
          const p = r.files.find((f) => f.role === "primary")!.path;
          writeFileSync(p, readFileSync(p, "utf8").replace(lineAt(n, 4), line(n, 4, v)));
          try {
            await user.importObject(addr(n), r.form, p, r.fingerprint, randomUUID());
            l4.set(n, v);
            return true;
          } catch (e) {
            if (e instanceof BridgeError && (e.code === "STALE_REVISION" || e.code === "NOT_FOUND")) continue; // rung imported meanwhile
            throw e;
          }
        }
        return false;
      };
      const fileEdit = (n: string, v: number) => {
        const p = join(ws, ...rel(n).split("/"));
        writeFileSync(p, readFileSync(p, "utf8").replace(lineAt(n, 1), line(n, 1, v)));
        l1.set(n, v);
      };
      const sync = async (what: string, killAfterMs?: number) => {
        let r: Awaited<ReturnType<typeof run>>;
        if (watchMode) {
          const killer = killAfterMs !== undefined ? setTimeout(killWatch, killAfterMs) : undefined;
          r = await run(["sync"]);
          clearTimeout(killer);
          if (!watcher) {
            r = { ...r, killed: true };
            await startWatch();
          }
        } else r = await run(["sync"], killAfterMs);
        const c = counts(r.out);
        log(`${what}: ${r.killed ? `killed after ${killAfterMs} ms` : `exit ${r.code}`} ${c ? JSON.stringify(c) : ""}`);
        if (!r.killed && (r.code === null || r.code > 2 || !c)) problems.push(`${what}: exit ${r.code}\n${r.out}`);
        if (c?.conflicts) problems.push(`${what}: a conflict although nobody edited the same line\n${r.out}`);
        if (/\bat .+\.(js|ts):\d+/.test(r.out)) problems.push(`${what}: a stack trace\n${r.out}`);
        return r;
      };
      // after a pass that ran to its end, both people's last values are in the file and in TIA Portal: checked at the
      // end only, a later edit could hide a value lost in between
      const kept = async (what: string, r: { killed: boolean; code: number | null }, skip: string[] = []) => {
        if (r.killed || r.code === null || r.code > 2) return;
        for (const n of NAMES) {
          if (!exists.get(n) || skip.includes(n)) continue;
          const file = join(ws, ...rel(n).split("/"));
          const texts: [string, string][] = [["the file", existsSync(file) ? readFileSync(file, "utf8") : ""], ["TIA Portal", ""]];
          try {
            const x = await user.exportObject(addr(n), "auto", mkdtempSync(join(tmpdir(), "rung-soak-tia-")));
            texts[1]![1] = readFileSync(x.files.find((f) => f.role === "primary")!.path, "utf8");
          } catch (e) {
            if (!(e instanceof BridgeError && e.code === "NOT_FOUND")) throw e;
          }
          for (const [where, text] of texts)
            for (const expected of [line(n, 1, l1.get(n)!), line(n, 4, l4.get(n)!)])
              if (!text.includes(expected)) problems.push(`${what}: ${expected} of ${n} is not in ${where} after the pass\n${text}`);
        }
      };

      const deadline = Date.now() + minutes * 60_000;
      let step = 0;
      while (Date.now() < deadline && !problems.length) {
        step++;
        const present = NAMES.filter((n) => exists.get(n));
        const absent = NAMES.filter((n) => !exists.get(n));
        const action = present.length === 0 ? "create" : pick(["file", "tia", "both", "concurrent", "kill", "kill", "create", "delete"]);
        const n = action === "create" ? pick(absent.length ? absent : present) : pick(present);
        const v = counter++;
        const label = `#${step} ${action} ${n}`;
        if (action === "create") {
          if (exists.get(n)) continue;
          mkdirSync(join(ws, "plc", ...folder.split("/")), { recursive: true });
          writeFileSync(join(ws, ...rel(n).split("/")), source(n, v));
          exists.set(n, true);
          l1.set(n, v);
          l4.set(n, START4);
          await kept(label, await sync(label, rand() < 0.5 ? 200 + Math.floor(rand() * 3300) : undefined));
        } else if (action === "file") {
          fileEdit(n, v);
          await kept(label, await sync(label));
        } else if (action === "tia") {
          await tiaEdit(n, v);
          await kept(label, await sync(label));
        } else if (action === "both") {
          fileEdit(n, v);
          await tiaEdit(n, v);
          await kept(label, await sync(label));
        } else if (action === "concurrent") {
          fileEdit(n, v);
          const other = pick(present);
          const [r] = await Promise.all([sync(label), new Promise((w) => setTimeout(w, Math.floor(rand() * 4000))).then(() => tiaEdit(other, counter++))]);
          void r;
        } else if (action === "kill") {
          fileEdit(n, v);
          if (rand() < 0.5) await tiaEdit(pick(present), counter++);
          await kept(label, await sync(label, 200 + Math.floor(rand() * 3300))); // a sync of the fixture takes 1.5–3 s
        } else if (action === "delete") {
          await kept(`${label} (before)`, await sync(`${label} (before)`));
          unlinkSync(join(ws, ...rel(n).split("/")));
          await kept(label, await sync(label), [n]); // n waits in TIA Portal for confirm-delete
          if (existsSync(join(ws, ...rel(n).split("/")))) {
            log(`${label}: the file came back (TIA changed it meanwhile)`);
            continue;
          }
          const d = await run(["confirm-delete", rel(n)]);
          log(`${label}: confirm-delete exit ${d.code} ${d.out.trim()}`);
          if (d.code !== 0) problems.push(`${label}: confirm-delete failed\n${d.out}`);
          else {
            exists.set(n, false);
            l1.delete(n);
            l4.delete(n);
          }
        }
      }

      expect(problems).toEqual([]); // the first problem ends the run; the log has the steps before it
      // quiet at the end: no more kills; at most a few passes until nothing moves
      let quiet = false;
      for (let i = 0; i < 6 && !quiet; i++) {
        const c = counts((await sync(`settle ${i}`)).out);
        quiet = !!c && c.exported + c.imported + c.created + c.merged === 0;
      }
      if (!quiet) problems.push("the workspace did not settle within 6 passes");

      // equal to TIA Portal, and every last value of both people is there
      const inTia = new Set((await user.listObjects("PLC_1")).map((e) => e.address));
      for (const n of NAMES) {
        const file = join(ws, ...rel(n).split("/"));
        if (!exists.get(n)) {
          if (existsSync(file) || inTia.has(addr(n))) problems.push(`${n} was deleted but is back (file ${existsSync(file)}, TIA ${inTia.has(addr(n))})`);
          continue;
        }
        if (!existsSync(file) || !inTia.has(addr(n))) {
          problems.push(`${n} is missing (file ${existsSync(file)}, TIA ${inTia.has(addr(n))})`);
          continue;
        }
        const r = await user.exportObject(addr(n), "auto", mkdtempSync(join(tmpdir(), "rung-soak-tia-")));
        const tia = readFileSync(r.files.find((f) => f.role === "primary")!.path, "utf8");
        const mine = readFileSync(file, "utf8");
        if (mine !== tia) problems.push(`${n}: the file differs from TIA Portal\n--- file\n${mine}\n--- TIA\n${tia}`);
        if (!mine.includes(line(n, 1, l1.get(n)!))) problems.push(`${n}: the file edit ${line(n, 1, l1.get(n)!)} got lost\n${mine}`);
        if (!mine.includes(line(n, 4, l4.get(n)!))) problems.push(`${n}: the TIA edit ${line(n, 4, l4.get(n)!)} got lost\n${mine}`);
      }
      const leftovers: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else if (/\.rung-tmp-|\.conflict$|\.tia$/.test(e.name)) leftovers.push(join(d, e.name));
        }
      };
      walk(join(ws, "plc"));
      if (leftovers.length) problems.push(`left behind: ${leftovers.join(", ")}`);
      const status = await run(["status"]);
      if (status.code !== 0) problems.push(`rung status: exit ${status.code}\n${status.out}`);
      log(`done after ${step} steps; ${problems.length} problems`);
      console.log(`soak: ${step} steps, ${problems.length} problems (log: ${logFile})`);
      expect(problems).toEqual([]);

      // leave the fixture as it was
      for (const e of await user.listObjects("PLC_1"))
        if (e.address.startsWith(`plc:${folder}/`)) await user.deleteObject(e.address, e.fingerprint, randomUUID()).catch(() => {});
    } finally {
      killWatch();
      await user.close();
    }
  }, (minutes + 20) * 60_000);
});
