// SPDX-License-Identifier: BUSL-1.1
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, access, writeFile, unlink, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadConfig, WorkspaceError } from "@rung/core";
import { bridgeFor, findWorkspace, readBoundedBytes, type Io } from "./common.js";
import type { DescribeNode } from "@rung/bridge-client";
import { modelSummary } from "./modelSummary.js";

/** Inspect the authoritative native manifest and raw documents without opening the engineering project. */
export async function cmdLibrary(dir: string, files: string[] | undefined, json: boolean, io: Io,
  options: { typeGuid?: string; versionGuid?: string; exportDir?: string; preview?: boolean; device?: string;
    apply?: boolean; expectedRevision?: string; expectedPackageRevision?: string; release?: boolean; update?: boolean; number?: string; author?: string; comment?: string;
    masterCopy?: string; from?: string } = {}): Promise<number> {
  if (options.masterCopy !== undefined || options.from !== undefined) {
    const name = /^[^\p{Cc}"/\\]{1,128}$/u;
    if (options.masterCopy === undefined || !name.test(options.masterCopy) || (options.from !== undefined && !name.test(options.from)) || !options.device
      || options.release || options.update || files?.length || options.exportDir || options.expectedPackageRevision || options.typeGuid || options.versionGuid || !!options.preview === !!options.apply
      || (options.apply ? !/^[0-9a-f]{64}$/.test(options.expectedRevision ?? "") : options.expectedRevision !== undefined))
      throw new WorkspaceError("BAD_ARGUMENT", "A master copy needs --master-copy <name>, --device, optionally --from <block>, and preview or apply with a reviewed revision");
    const config = await loadConfig(await findWorkspace(dir));
    if (!["V19", "V20", "V21"].includes(config.project.tiaVersion)) throw new WorkspaceError("BAD_ARGUMENT", "Master copies need TIA Portal V19, V20 or V21");
    if (options.apply && (config.writesOff || config.sync.import !== "auto")) throw new WorkspaceError("WRITES_OFF", "Master copies require writes on and sync.import = auto");
    const client = await bridgeFor(config, io, options.apply ? ["--allow-import", ...(config.sync.save === "after-import" ? ["--save-after-import"] : [])] : []);
    try {
      const request = { action: options.from === undefined ? "use" : "create", name: options.masterCopy, device: options.device, ...(options.from === undefined ? {} : { block: options.from }) };
      const result = await client.request(options.apply ? "library.mastercopy" : "library.mastercopy.preview",
        options.apply ? { ...request, expectedRevision: options.expectedRevision, operationId: randomUUID() } : request);
      io.stdout(JSON.stringify(result, null, json ? undefined : 2) + "\n"); return 0;
    } finally { await client.close(); }
  }
  if(options.update){
    if(options.release||files?.length||options.exportDir||options.expectedPackageRevision||options.number!==undefined||options.author!==undefined||options.comment!==undefined||!options.device||!!options.preview===!!options.apply
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.typeGuid??"")||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.versionGuid??"")
      ||(options.apply?!/^[0-9a-f]{64}$/.test(options.expectedRevision??""):options.expectedRevision!==undefined))throw new WorkspaceError("BAD_ARGUMENT","Update requires explicit type/default-version UUIDs, one --device and preview or apply with a reviewed revision");
    const config=await loadConfig(await findWorkspace(dir));if(!["V19","V20","V21"].includes(config.project.tiaVersion))throw new WorkspaceError("BAD_ARGUMENT","Native library update needs TIA Portal V19, V20 or V21");
    if(options.apply&&(config.writesOff||config.sync.import!=="auto"))throw new WorkspaceError("WRITES_OFF","Update requires writes on and sync.import = auto");
    const client=await bridgeFor(config,io,options.apply?["--allow-import",...(config.sync.save==="after-import"?["--save-after-import"]:[])]:[]);
    try{io.stdout(JSON.stringify(await client.request(options.apply?"library.update":"library.update.preview",{typeGuid:options.typeGuid,versionGuid:options.versionGuid,device:options.device,...(options.apply?{expectedRevision:options.expectedRevision,operationId:randomUUID()}: {})}),null,json?undefined:2)+"\n");return 0;}finally{await client.close();}
  }
  if (options.release) {
    if (files?.length || options.exportDir || options.device || options.expectedPackageRevision || !!options.preview === !!options.apply
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.typeGuid ?? "")
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.versionGuid ?? "")
      || !/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(options.number ?? "")
      || options.number === "0.0.0" || !options.author?.trim() || options.author.length > 128 || /\p{Cc}/u.test(options.author)
      || options.comment === undefined || options.comment.length > 4096 || options.comment.includes("\0")
      || (options.apply ? !/^[0-9a-f]{64}$/.test(options.expectedRevision ?? "") : options.expectedRevision !== undefined))
      throw new WorkspaceError("BAD_ARGUMENT", "Release requires explicit type/version UUIDs, --number, --author, --comment and preview or apply with a reviewed revision");
    const config = await loadConfig(await findWorkspace(dir));
    if (!["V19", "V20", "V21"].includes(config.project.tiaVersion)) throw new WorkspaceError("BAD_ARGUMENT", "Native library release needs TIA Portal V19, V20 or V21");
    if (options.apply && (config.writesOff || config.sync.import !== "auto")) throw new WorkspaceError("WRITES_OFF", "Release requires writes on and sync.import = auto");
    const client = await bridgeFor(config, io, options.apply ? ["--allow-import", ...(config.sync.save === "after-import" ? ["--save-after-import"] : [])] : []);
    try {
      const result = await client.request(options.apply ? "library.release" : "library.release.preview", {
        typeGuid: options.typeGuid, versionGuid: options.versionGuid, versionNumber: options.number, author: options.author, comment: options.comment,
        ...(options.apply ? { expectedRevision: options.expectedRevision, operationId: randomUUID() } : {}),
      });
      io.stdout(JSON.stringify(result, null, json ? undefined : 2) + "\n"); return 0;
    } finally { await client.close(); }
  }
  if (options.number !== undefined || options.author !== undefined || options.comment !== undefined) throw new WorkspaceError("BAD_ARGUMENT", "Release metadata requires --release");
  const exporting = options.exportDir !== undefined;
  const importing = options.preview || options.apply;
  if (options.preview && options.apply) throw new WorkspaceError("BAD_ARGUMENT", "Choose preview or apply");
  if ((importing && (files?.length !== 1 || exporting)) || (options.device && !importing))
    throw new WorkspaceError("BAD_ARGUMENT", "Import preview requires one --file and optionally --device");
  if (options.apply && (!/^[0-9a-f]{64}$/.test(options.expectedRevision ?? "") || !/^[0-9a-f]{64}$/.test(options.expectedPackageRevision ?? "")))
    throw new WorkspaceError("BAD_ARGUMENT", "Library apply requires --expected-revision and --expected-package-revision from a reviewed preview");
  if (!options.apply && (options.expectedRevision || options.expectedPackageRevision)) throw new WorkspaceError("BAD_ARGUMENT", "Expected revisions are used with --apply");
  if (files?.length && (exporting || options.typeGuid || options.versionGuid)) throw new WorkspaceError("BAD_ARGUMENT", "Choose library inspection or export");
  if (exporting || !files?.length) {
    if (files?.length || (!exporting && (options.typeGuid || options.versionGuid))) throw new WorkspaceError("BAD_ARGUMENT", "Choose library listing, inspection or export");
    if (exporting && (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.typeGuid ?? "")
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.versionGuid ?? "")))
      throw new WorkspaceError("BAD_ARGUMENT", "Export requires --type-guid and --version-guid UUIDs");
    const destination = exporting ? resolve(io.cwd, options.exportDir!) : undefined;
    if (destination) {
      try { await access(destination); throw new WorkspaceError("BAD_ARGUMENT", "Library export requires a new directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const config = await loadConfig(await findWorkspace(dir));
    if (!["V19", "V20", "V21"].includes(config.project.tiaVersion)) throw new WorkspaceError("BAD_ARGUMENT", "Native library packages needs TIA Portal V19, V20 or V21");
    const client = await bridgeFor(config, io);
    try {
      if (!destination) {
        const tree = await client.request("model.describe", { scope: "libraries", maxNodes: 4096 }) as DescribeNode;
        io.stdout(json ? JSON.stringify(tree) + "\n" : modelSummary(tree, "Libraries")); return 0;
      }
      const result = await client.request("library.export", {
        typeGuid: options.typeGuid, versionGuid: options.versionGuid,
      }) as { metadata: unknown; files: { name: string; contentBase64: string }[] };
      if (!Array.isArray(result.files) || result.files.length !== 2 || new Set(result.files.map(f => f.name)).size !== 2
        || result.files.some(f => !["type.xml", "type.libinfo"].includes(f.name) || typeof f.contentBase64 !== "string"
          || f.contentBase64.length > 5_592_408))
        throw new WorkspaceError("BAD_ARGUMENT", "Invalid native export response");
      const bytes = result.files.map(f => ({ name: f.name, bytes: Buffer.from(f.contentBase64, "base64") }));
      if (bytes.some((f, i) => !f.bytes.length || f.bytes.toString("base64") !== result.files[i]!.contentBase64)
        || bytes.reduce((sum, f) => sum + f.bytes.length, 0) > 4 * 1_048_576)
        throw new WorkspaceError("BAD_ARGUMENT", "Native library export exceeds size limit");
      await mkdir(destination); // No overwrite, including a directory created during the RPC.
      const written: string[] = [];
      try {
        for (const file of bytes) { const path = join(destination, file.name); await writeFile(path, file.bytes, { flag: "wx" }); written.push(path); }
      } catch (error) { for (const path of written) await unlink(path); await rmdir(destination); throw error; }
      io.stdout(JSON.stringify({ directory: destination, metadata: result.metadata }, null, json ? undefined : 2) + "\n"); return 0;
    } finally { await client.close(); }
  }
  if (files?.length !== 1) throw new WorkspaceError("BAD_ARGUMENT", "Library inspection requires one --file type.libinfo");
  const path = resolve(io.cwd, files[0]!), name = basename(path);
  if (!/^[A-Za-z0-9_-]{1,64}\.libinfo$/.test(name)) throw new WorkspaceError("BAD_ARGUMENT", "Unsupported native library metadata filename");
  const stem = name.slice(0, -8);
  let nativeFiles: { name: string; contentBase64: string }[];
  try {
    const metadata = await readBoundedBytes(path, "Library metadata");
    const document = await readBoundedBytes(join(dirname(path), stem + ".xml"), "Library document", 4 * 1_048_576);
    if (metadata.length + document.length > 4 * 1_048_576) throw new Error("Library package size limit exceeded (4 MiB)");
    nativeFiles = [{ name, contentBase64: metadata.toString("base64") }, { name: stem + ".xml", contentBase64: document.toString("base64") }];
  } catch (error) { throw new WorkspaceError("BAD_ARGUMENT", error instanceof Error ? error.message : String(error)); }
  const config = await loadConfig(await findWorkspace(dir));
  if (!["V19", "V20", "V21"].includes(config.project.tiaVersion)) throw new WorkspaceError("BAD_ARGUMENT", "Native library package inspection needs TIA Portal V19, V20 or V21");
  const device = options.device ?? (config.devices.length === 1 ? config.devices[0] : undefined);
  if (importing && !device) throw new WorkspaceError("BAD_ARGUMENT", "Library import requires --device for a workspace with multiple PLCs");
  if (options.apply && (config.writesOff || config.sync.import !== "auto")) throw new WorkspaceError("WRITES_OFF", "Library apply requires rung writes on and sync.import = auto");
  const client = await bridgeFor(config, io, options.apply ? ["--allow-import", ...(config.sync.save === "after-import" ? ["--save-after-import"] : [])] : []);
  try {
    const result = await client.request(options.apply ? "library.import" : options.preview ? "library.preview" : "library.inspect",
      options.apply ? { stem, device, files: nativeFiles, expectedRevision: options.expectedRevision, expectedPackageRevision: options.expectedPackageRevision, operationId: randomUUID() }
        : options.preview ? { stem, device, files: nativeFiles } : { stem, files: nativeFiles });
    if (!json) io.stdout(options.apply ? "Library imported in work; release and instance updates are separate operations.\n"
      : options.preview ? "Library import identity and name preflight passed; native import has not run.\n" : "Library metadata and raw XML hash checked.\n");
    io.stdout(JSON.stringify(result, null, json ? undefined : 2) + "\n"); return 0;
  } finally { await client.close(); }
}
