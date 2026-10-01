// SPDX-License-Identifier: BUSL-1.1
// In-memory stand-in for BridgeClient used by sync tests.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BridgeError, type ExportResult, type KnownRevision, type ObjectEntry, type ProjectInfo } from "@rung/bridge-client";

export interface FakeObject {
  entry: ObjectEntry;
  form: string;
  /** suffix → content; primary suffix is "." + form */
  files: Record<string, string>;
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

export class FakeBridge {
  objects = new Map<string, FakeObject>();
  info: ProjectInfo = { name: "RungFixture", path: "C:\\fx\\RungFixture\\RungFixture.ap20", tiaVersion: "V20", devices: ["PLC_1"], isLocalSession: false };
  failExport = new Set<string>();
  failList = false;
  exportCalls: string[] = [];
  /** Called after export wrote files, before returning (simulate concurrent edits). */
  afterExport?: (address: string) => void;

  add(address: string, opts: Partial<ObjectEntry> & { form?: string; content?: string; files?: Record<string, string> } = {}) {
    const form = opts.form ?? "scl";
    const files = opts.files ?? { ["." + form]: opts.content ?? `// ${address}\n` };
    const { form: _f, content: _c, files: _fs, ...rest } = opts;
    this.objects.set(address, {
      form,
      files,
      entry: { address, kind: "block", language: "SCL", blockType: "FC", knowHowProtected: false, isFailsafe: false, isSystem: false, fingerprint: "fp:" + sha(JSON.stringify(files)).slice(0, 8), ...rest },
    });
    return this;
  }

  edit(address: string, files: Record<string, string>) {
    const o = this.objects.get(address)!;
    o.files = files;
    if (o.entry.fingerprint.startsWith("fp:")) o.entry.fingerprint = "fp:" + sha(JSON.stringify(files)).slice(0, 8);
  }

  async projectInfo(): Promise<ProjectInfo> {
    return this.info;
  }

  /** What each listing was told the client knew from earlier passes. */
  known: (Record<string, KnownRevision> | undefined)[] = [];

  async listObjects(device: string, known?: Record<string, KnownRevision>): Promise<ObjectEntry[]> {
    this.known.push(known);
    if (this.failList) throw new BridgeError("PORTAL_DISPOSED", "portal went away");
    return [...this.objects.values()].filter((o) => o.entry.address.startsWith(`plc:${device}/`)).map((o) => ({ ...o.entry }));
  }

  renameCalls: { address: string; newName: string; rev: string }[] = [];

  /** Like TIA: the object gets the new name, every text that used the old one follows, no fingerprint changes. */
  async renameObject(address: string, newName: string, rev: string, _op: string): Promise<{ address: string }> {
    this.renameCalls.push({ address, newName, rev });
    const o = this.objects.get(address);
    if (!o) throw new BridgeError("NOT_FOUND", address);
    if (o.entry.fingerprint !== rev) throw new BridgeError("STALE_REVISION", address);
    const oldName = address.split("/").pop()!;
    const to = address.slice(0, address.length - oldName.length) + newName;
    this.objects.delete(address);
    const swap = (t: string) => t.split(`"${oldName}"`).join(`"${newName}"`);
    o.entry = { ...o.entry, address: to };
    o.files = Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, swap(v)]));
    this.objects.set(to, o);
    for (const other of this.objects.values()) other.files = Object.fromEntries(Object.entries(other.files).map(([k, v]) => [k, swap(v)]));
    return { address: to };
  }

  async exportObject(address: string, _form: string, dir: string): Promise<ExportResult> {
    this.exportCalls.push(address);
    if (this.failExport.has(address)) throw new BridgeError("EXPORT_FAILED", "cannot export " + address);
    const o = this.objects.get(address);
    if (!o) throw new BridgeError("NOT_FOUND", address);
    const files = Object.entries(o.files).map(([suffix, content]) => {
      const path = join(dir, "obj" + suffix);
      writeFileSync(path, content);
      return { path, role: suffix === "." + o.form ? "primary" : "companion" + suffix, sha256: sha(content) };
    });
    this.afterExport?.(address);
    return { address, form: o.form, files, warnings: o.entry.isConsistent === false ? ["INCONSISTENT"] : [], fingerprint: o.entry.fingerprint, bundleHash: "ignored" };
  }
}
