// SPDX-License-Identifier: BUSL-1.1
// Process-level fake of rung-bridge for CLI tests. Objects live in FAKE_OBJECTS (JSON file, rewritten on import/delete).
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
// what the bridge process was given for downloads (tests check that it is never inherited)
if (process.env.FAKE_ENV_OUT) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ allowDownload: process.env.RUNG_CODESYS_ALLOW_DOWNLOAD ?? null, argv }));
const projectArg = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : null;
const allowImport = argv.includes("--allow-import") || argv.includes("--allow-fixture-import");
const load = () => JSON.parse(readFileSync(process.env.FAKE_OBJECTS, "utf8"));
const save = (db) => writeFileSync(process.env.FAKE_OBJECTS, JSON.stringify(db));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const fp = (o) => "fp:" + sha(o.content).slice(0, 8);
const entry = (o) => o.entry ?? { address: o.address, kind: o.address.includes("/types/") ? "type" : "block", language: "SCL", knowHowProtected: false, isFailsafe: false, isSystem: false, fingerprint: fp(o) };
const form = (o) => o.form ?? (o.address.includes("/types/") ? "udt" : "scl");

function exportTo(o, dir) {
  const path = join(dir, "obj." + form(o));
  writeFileSync(path, o.content);
  return { address: o.address, form: form(o), files: [{ path, role: "primary", sha256: sha(o.content) }], warnings: [], fingerprint: fp(o), bundleHash: "x" };
}

/** Files named and carried, as the bridge answers a client on another machine. */
const inline = (r) => ({ ...r, files: r.files.map((f) => ({ ...f, content: readFileSync(f.path, "utf8"), path: basename(f.path) })) });

const rl = createInterface({ input: process.stdin });
// FAKE_LOG: what a read-only command asked for and that it ended its bridge (a client closes it by ending its
// input); off by default, since every log rewrites the shared file
const logging = !!process.env.FAKE_LOG;
rl.on("close", () => {
  if (!logging) return;
  try {
    const db = load();
    db.exits = (db.exits ?? 0) + 1;
    save(db);
  } catch {
    // a test that already removed its files
  }
});
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const reply = (result) => out({ id: req.id, result });
  const fail = (code, message) => out({ id: req.id, error: { code, message } });
  const p = req.params ?? {};
  const db = load();
  if (logging) {
    db.methods = [...(db.methods ?? []), req.method === "plc.online" ? `plc.online ${p.action}` : req.method];
    save(db);
  }
  if (req.method !== "bridge.hello" && process.env.FAKE_ACCESS_DENIED) return fail("ACCESS_DENIED", "not in group Siemens TIA Openness");
  if (req.method !== "bridge.hello" && projectArg && projectArg.toLowerCase() !== db.project.path.toLowerCase())
    return fail("NO_PROJECT", "Project is not open in any TIA Portal instance: " + projectArg);
  switch (req.method) {
    case "bridge.hello":
      // how often a bridge was started (a TIA Portal the real one may open)
      db.starts = (db.starts ?? 0) + 1;
      db.startArgs = [...(db.startArgs ?? []), argv];
      save(db);
      return reply({ protocol: 1, tiaVersion: "V20", bridgeVersion: "fake", capabilities: allowImport ? ["import"] : [] });
    case "project.info":
      // no TIA Portal has a project open, and none was named: what the real bridge answers then
      if (process.env.FAKE_NO_PROJECT && !projectArg) return fail("NO_PROJECT", "No TIA Portal instance has a project open.");
      return reply(db.project);
    case "objects.list":
      return reply(db.objects.filter((o) => o.address.startsWith(`plc:${p.device}/`)).map(entry));
    case "objects.export": {
      const o = db.objects.find((x) => x.address === p.address);
      if (!o) return fail("NOT_FOUND", p.address);
      if (p.inline) {
        db.inline = [...(db.inline ?? []), "export"];
        save(db);
        return reply(inline(exportTo(o, mkdtempSync(join(tmpdir(), "fake-bridge-")))));
      }
      return reply(exportTo(o, p.dir));
    }
    case "objects.import": {
      if (!allowImport) return fail("READ_ONLY", "imports need --allow-import");
      if (db.refuseImports) return fail("IMPORT_FAILED", db.refuseImports);
      // a client on another machine sends the files (inline); a local one names a path
      const sent = p.files ? p.files.find((f) => f.name === p.primary) : undefined;
      if (p.files) db.inline = [...(db.inline ?? []), "import " + p.files.map((f) => f.name).join(",")];
      const text = sent ? sent.content : readFileSync(p.path, "utf8");
      let o = db.objects.find((x) => x.address === p.address);
      if (p.expectedTiaRevision === "absent") {
        if (o) return fail("STALE_REVISION", "exists");
        o = { address: p.address, content: text, form: p.form };
        db.objects.push(o);
      } else {
        if (!o) return fail("NOT_FOUND", p.address);
        if (fp(o) !== p.expectedTiaRevision) return fail("STALE_REVISION", "changed in TIA");
        o.content = text.replace(/\bbegin\b/g, "BEGIN"); // TIA canonicalizes keyword casing
      }
      save(db);
      const out = exportTo(o, mkdtempSync(join(tmpdir(), "fake-bridge-")));
      return reply(p.files ? inline(out) : out);
    }
    case "objects.delete": {
      if (!allowImport) return fail("READ_ONLY", "deletes need --allow-import");
      const i = db.objects.findIndex((x) => x.address === p.address);
      if (i < 0) return fail("NOT_FOUND", p.address);
      if (fp(db.objects[i]) !== p.expectedTiaRevision) return fail("STALE_REVISION", "changed");
      db.objects.splice(i, 1);
      save(db);
      return reply({ deleted: true });
    }
    case "objects.rename": {
      // like TIA: the object gets the new name and every text naming the old one follows; fingerprints of users stay
      if (!allowImport) return fail("READ_ONLY", "renames need --allow-import");
      const o = db.objects.find((x) => x.address === p.address);
      if (!o) return fail("NOT_FOUND", p.address);
      if (fp(o) !== p.expectedTiaRevision) return fail("STALE_REVISION", "changed");
      const old = o.address.split("/").pop();
      o.address = o.address.slice(0, o.address.length - old.length) + p.newName;
      if (o.entry) o.entry.address = o.address;
      for (const x of db.objects) if (typeof x.content === "string") x.content = x.content.split(`"${old}"`).join(`"${p.newName}"`);
      save(db);
      return reply({ address: o.address });
    }
    case "plc.online": {
      if (process.env.FAKE_ONLINE_ERROR && p.action === "online") return fail("NO_TARGET", process.env.FAKE_ONLINE_ERROR);
      db.online = p.action === "online" ? "Online" : p.action === "offline" ? "Offline" : (db.online ?? "Offline");
      if (p.action === "online") db.onlineTarget = p.target ?? null;
      save(db);
      return reply({ device: p.device, state: db.online });
    }
    case "xref.get":
      // db.xref[address]: entries as the real bridge answers them; none otherwise
      return reply((db.xref ?? {})[p.address] ?? []);
    case "plc.read":
      // db.values: expression -> value; one it does not have reads as an error, as CODESYS answers it
      if (db.online !== "Online") return fail("NOT_ONLINE", `${p.device} is not online; rung online first`);
      return reply(p.expressions.map((name) => (name in (db.values ?? {}) ? { name, value: db.values[name] } : { name, error: `${name} is unknown` })));
    case "plc.compare": {
      // db.compare: items to report; default: one mirrored block differs
      db.compareTarget = p.target ?? null;
      save(db);
      const first = db.objects[0];
      const items = db.compare ?? (first ? [{ path: `Program blocks/${first.address.split("/").pop()} [FB1]`, name: first.address.split("/").pop(), state: "Different", detail: "Objects are different. ", address: first.address }] : []);
      return reply({ device: p.device, state: items.length ? "FolderContentsDifferent" : "FolderContentsIdentical", identical: 7, items });
    }
    case "plc.connections": {
      // db.reach: [{ pc, address }] = what each PG/PC interface can see; default: the PLC at its project address on "Ethernet"
      const reach = db.reach ?? [{ pc: "Ethernet", address: "192.168.0.1" }];
      const pcs = [...new Set(["Ethernet", "Wi-Fi", ...reach.map((r) => r.pc)])];
      db.scans = (db.scans ?? 0) + (p.scan ? 1 : 0);
      save(db);
      return reply({
        device: p.device,
        configured: !!db.tiaConfigured,
        plcAddresses: [{ interface: "PROFINET interface_1", address: "192.168.0.1" }, { interface: "PROFINET interface_2", address: "192.168.1.1" }],
        modes: [{ name: "PN/IE", pcInterfaces: pcs.map((pc) => ({ name: pc, number: 1, targetInterfaces: ["1 X1", "1 X2"], subnets: [], ...(p.scan ? { accessible: reach.filter((r) => r.pc === pc).map((r) => ({ name: "plc_1", address: r.address, deviceSeries: "S7-1500", macAddress: "00-00" })) } : {}) })) }],
      });
    }
    case "plc.download": {
      // like the real bridge: only one started for downloads may download
      if (!argv.includes("--allow-download")) return fail("DOWNLOAD_DISABLED", "This bridge was not started for downloads");
      const r = p.request;
      db.downloads = [...(db.downloads ?? []), r];
      save(db);
      const stop = (r.allow ?? []).includes("stop-cpu");
      // a test's own outcome (decisions after the transfer, an error); "throw" fails the call like a lost bridge
      if (db.downloadOutcome === "throw") return fail("TIMEOUT", "plc.download timed out after 300000 ms");
      if (db.downloadOutcome) return reply({ device: r.device, errors: 0, warnings: 0, messages: [], needsAllow: [], ...db.downloadOutcome });
      return reply({ device: r.device, state: stop ? "Success" : "Cancelled", errors: 0, warnings: 0, messages: [], decisions: [{ phase: "pre", kind: "StopModules", name: "stop-cpu", choice: stop ? "StopAll" : "NoAction", allowed: stop, blocks: !stop }], needsAllow: stop ? [] : ["stop-cpu"] });
    }
    case "plc.upload": {
      if (!allowImport) return fail("IMPORT_DISABLED", "imports are off");
      db.uploads = [...(db.uploads ?? []), { request: p.request, argv }];
      if (!db.project.devices.includes("PLC_2")) db.project.devices.push("PLC_2");
      save(db);
      return reply({ state: "Success", station: "S7-1500 station_2", plcs: ["PLC_2"], messages: ["Upload completed"], ...(process.env.FAKE_SAVE_ERROR ? { saveError: process.env.FAKE_SAVE_ERROR, stationRemoved: true } : {}) });
    }
    case "objects.show":
      return fail("UNSUPPORTED_CAPABILITY", "TIA Portal was started without user interface");
    case "project.archive": {
      // like TIA Portal: an archive of the saved project; FAKE_ARCHIVE_ERROR makes it fail
      if (process.env.FAKE_ARCHIVE_ERROR) return fail("INTERNAL", process.env.FAKE_ARCHIVE_ERROR);
      const path = `${p.dir ?? "C:\\Users\\me\\AppData\\Local\\rung\\backups\\RungFixture"}\\RungFixture_${String(Date.now())}.zap20`;
      db.archives = [...(db.archives ?? []), path];
      save(db);
      return reply({ path, bytes: 4096, savedFirst: false, removed: [] });
    }
    case "plc.compile":
      if (p.hardware) return reply([{ severity: "info", description: "Hardware compiled" }]);
      if (db.compileMessages) return reply(db.compileMessages);
      return reply((p.addresses ?? []).filter((a) => (db.objects.find((o) => o.address === a)?.content ?? "").includes("#undeclared")).map((a) => ({ address: a, severity: "error", description: "Tag #undeclared not defined" })));
    default:
      return fail("BAD_REQUEST", "unknown " + req.method);
  }
});
