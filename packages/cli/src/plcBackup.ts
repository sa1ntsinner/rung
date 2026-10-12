// SPDX-License-Identifier: BUSL-1.1
// rung backup --from-plc: everything rung can read from a running S7-1500, into one new folder, the PLC only read.
// Station upload into a new project (TIA Portal's "Upload device as new station"), that project archived and mirrored
// as text, compared online against the PLC (proof the copy is complete), CPU identity and state, its certificate,
// active alarms, and the values of every data block. Not a native CPU image (Siemens' "backup from online device"
// stops the CPU, so rung never uses it). Works under the read-only lock: that is the intended way to run it.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { WorkspaceError, loadConfig, saveConfig } from "@rung/core";
import { WorkspaceIndex, uriOf } from "@rung/lsp";
import { bridgeFor, type Io } from "./common.js";
import { monitorPlan } from "./monitor.js";
import { closePlcLinks } from "./plc.js";
import { inspectCertificate } from "./liveTrust.js";
import { brokerReader } from "./liveServer.js";
import type { LiveReader } from "./live.js";

export interface PlcBackupSteps {
  init(dir: string, v: Record<string, unknown>, io: Io): Promise<number>;
  pull(dir: string, v: Record<string, unknown>, io: Io): Promise<number>;
  compare(dir: string, v: Record<string, unknown>, io: Io): Promise<number>;
  compile(dir: string, v: Record<string, unknown>, io: Io): Promise<number>;
  /** Closes the project in rung's background TIA Portal, dropping what the compile changed: project/ stays as uploaded. */
  release(dir: string, io: Io): Promise<number>;
  /** Whether a TIA Portal still has the project open (its files change until it is closed). */
  open(dir: string, io: Io): Promise<boolean>;
  archive(dir: string, out: string, io: Io): Promise<string | undefined>;
  certificate(address: string, env: Io["env"]): Promise<{ certificateSha256: string; details: string }>;
  reader(dir: string, env: Io["env"], device: string): Promise<LiveReader>;
}

interface Step { name: string; status: "ok" | "failed" | "skipped"; ms: number; detail?: string }

/** Files that come and go while TIA Portal or rung's live broker run: TIA Portal's lock and temporary files, the broker's owner record. */
const SCRATCH = /^~|\.tmp$|^live-owner\.json$/i;

/** At most this many values per read, and a pause between reads: the CPU serves an engineer's reads on the side. */
const BATCH = 16, PAUSE_MS = 250;

export const realSteps = (init: PlcBackupSteps["init"], pull: PlcBackupSteps["pull"], compare: PlcBackupSteps["compare"], compile: PlcBackupSteps["compile"], session: (dir: string, v: Record<string, unknown>, io: Io) => Promise<number>): PlcBackupSteps => ({
  init, pull, compare, compile,
  // compare and compile keep their bridge attached until the command ends: closed first, or they hold the project
  release: async (dir, io) => { await closePlcLinks(); try { return await session(dir, { release: true, discard: true }, io); } finally { await closePlcLinks(); } },
  open: async (dir, io) => {
    const said: string[] = [];
    await session(dir, { json: true }, { ...io, stdout: s => { said.push(s); }, stderr: () => {} }).catch(() => 0);
    try { return (JSON.parse(said.join("")) as { open?: boolean }).open !== false; } catch { return false; }
  },
  archive: async (dir, out, io) => {
    const client = await bridgeFor(await loadConfig(dir), io);
    try { return (await client.archive(out))?.path; } finally { await client.close(); }
  },
  certificate: inspectCertificate,
  reader: (dir, env, device) => brokerReader(dir, env, { device, transport: "s7commplus" }),
});

export async function cmdPlcBackup(v: Record<string, unknown>, io: Io, steps: PlcBackupSteps): Promise<number> {
  const address = String(v["from-plc"]);
  if (!v.out) throw new WorkspaceError("BAD_ARGUMENT", "rung backup --from-plc <ip> needs --out <new folder>");
  const out = resolve(io.cwd, String(v.out));
  if (await readdir(out).then(list => list.length > 0, () => false)) throw new WorkspaceError("BAD_ARGUMENT", `${out} is not empty; a backup goes into a new folder`);
  const expected = v["expect-sha256"] === undefined ? undefined : String(v["expect-sha256"]).replace(/[:\s]/g, "").toUpperCase();
  if (expected !== undefined && !/^[A-F0-9]{64}$/.test(expected)) throw new WorkspaceError("BAD_ARGUMENT", "--expect-sha256 needs the 64 hex digits of the certificate's SHA-256");
  const trust = v["trust-certificate"] === true;
  await mkdir(out, { recursive: true });
  const ws = join(out, "program"), project = join(out, "project", "upload", "upload.ap20");
  const started = new Date(), log: Step[] = [], files: Record<string, unknown> = {};
  const quiet = (sink: string[]): Io => ({ ...io, stdout: s => { sink.push(s); }, stderr: s => { sink.push(s); } });
  const step = async (name: string, run: () => Promise<string | void>): Promise<boolean> => {
    const t0 = Date.now();
    io.stderr(`rung backup: ${name} …\n`);
    try { const detail = await run(); log.push({ name, status: "ok", ms: Date.now() - t0, ...(detail ? { detail } : {}) }); return true; }
    catch (e) { const detail = e instanceof Error ? e.message : String(e); log.push({ name, status: "failed", ms: Date.now() - t0, detail }); io.stderr(`rung backup: ${name} failed: ${detail}\n`); return false; }
  };
  const skip = (name: string, detail: string) => { log.push({ name, status: "skipped", ms: 0, detail }); io.stderr(`rung backup: ${name} skipped: ${detail}\n`); };
  // the project's files change until TIA Portal has closed it: the hashes are taken only after that
  const close = () => step("close project", async () => {
    // the bridges of the steps before detach from TIA Portal a moment after they end: until then it counts them as users
    let said: string[] = [], code = 1;
    for (let i = 0; i < 30; i++) {
      said = [];
      code = await steps.release(ws, quiet(said)).catch((e: unknown) => { said.push(String(e)); return 1; });
      if (code === 0 || !/PROJECT_IN_USE|uses it/i.test(said.join(""))) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (code !== 0) throw new Error(said.join("").trim() || `exit ${code}`);
    for (let i = 0; i < 60 && await steps.open(ws, quiet([])); i++) await new Promise(r => setTimeout(r, 1000));
    if (await steps.open(ws, quiet([]))) throw new Error("TIA Portal still has the project open");
  });

  // 1. the station as it runs, into a project created for it (allowed under the read-only lock, the PLC only read)
  const uploaded = await step("upload", async () => {
    const said: string[] = [];
    const code = await steps.init(ws, { "from-plc": address, project, ...pick(v, ["use", "mode", "number", "trust-certificate"]) }, quiet(said));
    await writeFile(join(out, "upload.log"), said.join(""));
    if (code !== 0) throw new Error(said.join("").trim().split("\n").filter(l => l.startsWith("rung:")).at(-1)?.replace(/^rung: /, "") ?? `exit ${code}`);
  });
  if (!uploaded) return finish(out, address, started, log, files, io, 1);
  const config = await loadConfig(ws);
  const device = (v.device as string[] | undefined)?.[0] ?? (config.devices.length ? config.devices[0] : /devices: ([^,)]+)/.exec(await readFile(join(out, "upload.log"), "utf8"))?.[1]);
  if (!device) { skip("compare", "the upload brought no PLC"); await close(); return finish(out, address, started, log, files, io, 2); }

  // 2. the copy proven complete before anything else touches the project: TIA Portal compares it with the PLC
  await step("compare", async () => {
    const said: string[] = [];
    const code = await steps.compare(ws, { json: true, plc: device, ...(trust ? { "trust-certificate": true } : {}) }, quiet(said));
    await writeFile(join(out, "compare.json"), said.join(""));
    const report = JSON.parse(said.join("")) as { items: unknown[]; identical: number };
    files.compare = { identical: report.identical, differing: report.items.length };
    if (code !== 0) throw new Error(`${report.items.length} objects differ between the uploaded project and the PLC`);
    return `${report.identical} objects identical`;
  });
  // 3. the project as TIA Portal opens it anywhere, untouched
  await step("archive", async () => { const path = await steps.archive(ws, out, quiet([])); if (!path) throw new Error("this bridge cannot archive"); files.archive = relative(out, path); return relative(out, path); });
  // 4. the program as text: TIA Portal exports only compiled blocks, and an upload's are not; compiled in rung's
  // background TIA Portal and dropped again when it closes, so project/ and the archive stay as uploaded
  await step("program text", async () => {
    const said: string[] = [];
    const compiled = await steps.compile(ws, { plc: device }, quiet(said));
    const code = await steps.pull(ws, {}, quiet(said));
    await writeFile(join(out, "pull.log"), said.join(""));
    if (code === 1) throw new Error("rung pull failed");
    const failed = said.join("").split("\n").filter(l => /EXPORT_FAILED/.test(l)).length;
    if (failed) throw new Error(`${failed} objects could not be exported as text${compiled !== 0 ? " (the compile reported errors)" : ""}; see pull.log`);
  });
  await close();

  // 5. the running CPU over S7CommPlus (TLS): its certificate first, trusted only as the user said
  let reader: LiveReader | undefined;
  const certified = await step("certificate", async () => {
    const cert = await steps.certificate(address, io.env);
    await writeFile(join(out, "certificate.txt"), cert.details + "\n");
    const sha = cert.certificateSha256.toUpperCase();
    files.certificateSha256 = sha;
    if (expected !== undefined && sha !== expected) throw new Error(`the PLC's certificate has SHA-256 ${sha}, not the expected ${expected}`);
    if (expected === undefined && !trust) throw new Error("not trusted: pass --expect-sha256 <fingerprint> or --trust-certificate");
    const c = await loadConfig(ws, { raw: true });
    c.live = { ...c.live, plc: { ...c.live?.plc, [device]: { transport: "s7commplus", address, allowWrites: false, readOnly: true, certificateSha256: sha } } };
    await saveConfig(ws, c);
    return expected !== undefined ? "matches the expected fingerprint" : "trusted for this backup (--trust-certificate)";
  });
  if (!certified) skip("cpu, alarms, values", "no trusted certificate");
  else {
    try {
      await step("cpu state", async () => { reader = await steps.reader(ws, io.env, device); const s = await reader.state!(); await writeFile(join(out, "cpu.json"), JSON.stringify(s, null, 2) + "\n"); files.cpu = { ...s.identity, mode: s.state.mode, cycleMs: s.state.cycleMs }; });
      if (reader) {
        await step("alarms", async () => { const a = await reader!.alarms!(1033); await writeFile(join(out, "alarms.json"), JSON.stringify(a, null, 2) + "\n"); return `${a.alarms.length} active`; });
        if (v["no-values"]) skip("values", "--no-values");
        else await step("values", async () => { const r = await captureValues(ws, device, reader!, join(out, "values")); files.values = r; if (r.failed) return `${r.values} values, ${r.failed} not readable`; return `${r.values} values of ${r.blocks} data blocks`; });
        await step("cpu state after", async () => { const s = await reader!.state!(); files.cycleAfterMs = s.state.cycleMs; files.modeAfter = s.state.mode; });
      }
    } finally { await reader?.close().catch(() => {}); }
  }
  return finish(out, address, started, log, files, io, log.some(s => s.status !== "ok") ? 2 : 0);
}

function pick(v: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
}

/** Every data block's values, read through the plans the monitor makes (instance and UDT-typed DBs included). */
async function captureValues(ws: string, device: string, reader: LiveReader, dir: string): Promise<{ blocks: number; values: number; failed: number; unplanned: string[] }> {
  await mkdir(dir, { recursive: true });
  const index = new WorkspaceIndex(); await index.load(ws);
  const files = (await listFiles(join(ws, "plc", device))).filter(f => /\.db$/i.test(f));
  let blocks = 0, values = 0, failed = 0;
  const unplanned: string[] = [];
  for (const file of files) {
    let vars: Record<string, string>;
    try { vars = monitorPlan(index, uriOf(file)).vars; }
    catch (e) { unplanned.push(`${relative(ws, file)}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    const labels = Object.keys(vars);
    if (!labels.length) continue;
    const rows: Record<string, unknown> = {};
    for (let i = 0; i < labels.length; i += BATCH) {
      const chunk = labels.slice(i, i + BATCH);
      const read = await reader.read(chunk.map(l => vars[l]!));
      const at = Date.now();
      chunk.forEach((label, n) => { const r = read[n]; rows[label] = r?.error ? { error: r.error } : { value: r?.value, ...(r?.display !== undefined ? { display: r.display } : {}), at }; if (r?.error) failed++; else values++; });
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
    blocks++;
    const name = file.split(sep).at(-1)!.replace(/\.db$/i, "");
    await writeFile(join(dir, `${name}.json`), JSON.stringify(rows, null, 2) + "\n");
  }
  if (unplanned.length) await writeFile(join(dir, "not-captured.txt"), unplanned.join("\n") + "\n");
  return { blocks, values, failed, unplanned };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(e => e.isDirectory() ? listFiles(join(dir, e.name)) : Promise.resolve([join(dir, e.name)])));
  return nested.flat();
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function finish(out: string, address: string, started: Date, steps: Step[], files: Record<string, unknown>, io: Io, code: number): Promise<number> {
  const manifest = { format: 1, kind: "rung-plc-backup", plc: address, started: started.toISOString(), ended: new Date().toISOString(), complete: code === 0, steps, results: files,
    notIncluded: ["a native CPU image (Siemens' backup from online device stops the CPU)", "watch and force tables (offline objects; not in an upload)", "web server users and passwords", "device-internal parameters of drives and gateways", "SD card files other than the program"] };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(out, "README.txt"), [
    `Backup of the PLC at ${address}, ${started.toISOString()} (rung backup --from-plc). The PLC was only read.`,
    "project/      the station as it ran, uploaded into a new TIA Portal project (open it in TIA Portal)",
    "*.zap*        the same project archived (TIA Portal: Project > Retrieve)",
    "program/      the program as text (a rung workspace bound to project/)",
    "compare.json  TIA Portal's online compare of project/ with the PLC right after the upload",
    "cpu.json, certificate.txt, alarms.json, values/   the running CPU",
    "manifest.json each step with its result; SHA256SUMS the files' hashes (rung backup verify checks them)",
    "", "Not included: " + manifest.notIncluded.join("; ") + ".", "",
  ].join("\n"));
  const all = (await listFiles(out)).filter(f => !f.endsWith(`${sep}SHA256SUMS`) && !SCRATCH.test(f.split(sep).at(-1)!));
  const lines: string[] = [];
  for (const f of all.sort()) if ((await stat(f)).isFile()) lines.push(`${await sha256(f)}  ${relative(out, f).split(sep).join("/")}`);
  await writeFile(join(out, "SHA256SUMS"), lines.join("\n") + "\n");
  const failed = steps.filter(s => s.status !== "ok");
  io.stdout(`${code === 0 ? "complete" : code === 2 ? "partial" : "failed"} backup of ${address} in ${out}${failed.length ? ` (${failed.map(s => `${s.name}: ${s.status}`).join(", ")})` : ""}\n`);
  return code;
}

/** `rung backup verify <folder>`: every file still has the hash the backup wrote; nothing is connected. */
export async function cmdBackupVerify(dir: string, io: Io): Promise<number> {
  const sums = await readFile(join(dir, "SHA256SUMS"), "utf8").catch(() => { throw new WorkspaceError("BAD_ARGUMENT", `${dir} has no SHA256SUMS: not a rung backup`); });
  const bad: string[] = [];
  let checked = 0;
  for (const line of sums.split(/\r?\n/).filter(Boolean)) {
    const [hash, ...rest] = line.split("  "), file = join(dir, ...rest.join("  ").split("/"));
    const now = await sha256(file).catch(() => "missing");
    checked++;
    if (now !== hash) bad.push(`${rest.join("  ")}: ${now === "missing" ? "missing" : "changed"}`);
  }
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8").catch(() => "{}")) as { complete?: boolean; steps?: Step[] };
  for (const b of bad) io.stdout(`  ${b}\n`);
  io.stdout(`${checked - bad.length} of ${checked} files as backed up${manifest.complete === false ? `; the backup itself was partial (${(manifest.steps ?? []).filter(s => s.status !== "ok").map(s => s.name).join(", ")})` : ""}\n`);
  return bad.length ? 1 : 0;
}

/** `rung backup diff <a> <b>`: what changed between two backups of a PLC (program files, values, CPU). */
export async function cmdBackupDiff(a: string, b: string, io: Io): Promise<number> {
  const sums = async (d: string) => new Map((await readFile(join(d, "SHA256SUMS"), "utf8")).split(/\r?\n/).filter(Boolean).map(l => { const [h, ...p] = l.split("  "); return [p.join("  "), h!] as const; }));
  const [x, y] = [await sums(a), await sums(b)];
  const program = (m: Map<string, string>) => [...m.keys()].filter(k => k.startsWith("program/plc/"));
  const changed = [...new Set([...program(x), ...program(y)])].filter(k => x.get(k) !== y.get(k)).sort();
  for (const k of changed) io.stdout(`  program  ${!x.has(k) ? "added  " : !y.has(k) ? "removed" : "changed"}  ${k.slice("program/".length)}\n`);
  let values = 0;
  for (const k of [...y.keys()].filter(k => /^values\/.+\.json$/.test(k) && x.has(k) && x.get(k) !== y.get(k)).sort()) {
    const [va, vb] = [JSON.parse(await readFile(join(a, k), "utf8")), JSON.parse(await readFile(join(b, k), "utf8"))] as Record<string, { value?: unknown; error?: string }>[];
    for (const label of Object.keys(vb!)) {
      const before = va![label]?.value, after = vb![label]?.value;
      if (JSON.stringify(before) !== JSON.stringify(after)) { values++; io.stdout(`  value    ${k.slice(7, -5)}.${label}: ${JSON.stringify(before)} → ${JSON.stringify(after)}\n`); }
    }
  }
  const cpu = async (d: string) => JSON.parse(await readFile(join(d, "cpu.json"), "utf8").catch(() => "{}")) as { identity?: Record<string, string> };
  const [ca, cb] = [await cpu(a), await cpu(b)];
  for (const key of ["cpu", "firmware", "serial", "plcName"]) if (ca.identity?.[key] !== cb.identity?.[key]) io.stdout(`  cpu      ${key}: ${ca.identity?.[key]} → ${cb.identity?.[key]}\n`);
  io.stdout(`${changed.length} program files and ${values} values differ\n`);
  return changed.length ? 2 : 0;
}
