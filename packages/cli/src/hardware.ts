// SPDX-License-Identifier: BUSL-1.1
import { resolve } from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { loadConfig, WorkspaceError } from "@rung/core";
import { hardwarePatchText } from "@rung/lsp";
import { bridgeFor, findWorkspace, readBoundedBytes, type Io } from "./common.js";

/** Snapshot and preview stay read-only; --apply explicitly enables guarded offline imports. */
export async function cmdHardware(dir: string, files: string[] | undefined, json: boolean, io: Io, apply = false,expectedArtifactRevision?:string): Promise<number> {
  if (files && files.length !== 1) throw new WorkspaceError("BAD_ARGUMENT", "Hardware preview takes exactly one --file patch.json");
  if (apply && !files?.[0]) throw new WorkspaceError("BAD_ARGUMENT", "Hardware --apply requires --file patch.json");
  let patchText: string | undefined;
  try {
    if(expectedArtifactRevision!==undefined&&(!apply||!/^[0-9a-f]{64}$/.test(expectedArtifactRevision)))throw new Error("Reviewed artifact hash requires apply");
    const bytes=files?.[0]?await readBoundedBytes(resolve(io.cwd,files[0]),"Hardware patch"):undefined;
    if(expectedArtifactRevision&&createHash("sha256").update(bytes!).digest("hex")!==expectedArtifactRevision)throw new Error("Hardware file differs from the reviewed artifact");
    patchText=bytes?.toString("utf8");
    if (patchText !== undefined) patchText = hardwarePatchText(patchText);
  } catch (error) { throw new WorkspaceError("BAD_ARGUMENT", error instanceof Error ? error.message : String(error)); }
  const config = await loadConfig(await findWorkspace(dir));
  if (config.project.tiaVersion === "CODESYS") throw new WorkspaceError("BAD_ARGUMENT", "Hardware snapshots require a TIA project");
  if (apply && (config.writesOff || config.sync.import !== "auto")) throw new WorkspaceError("WRITES_OFF", "Hardware apply requires rung writes on and sync.import = auto");
  const client = await bridgeFor(config, io, apply ? ["--allow-import", ...(config.sync.save === "after-import" ? ["--save-after-import"] : [])] : []);
  try {
    const result = await client.request(apply ? "hardware.apply" : patchText === undefined ? "hardware.snapshot" : "hardware.preview", patchText === undefined ? {} : { patchText, ...(apply ? { operationId: randomUUID() } : {}) });
    if (!json && patchText !== undefined) io.stdout(apply ? "Hardware changes applied; no PLC download.\n" : "Hardware preview only; no project changes applied.\n");
    io.stdout(JSON.stringify(result, null, json ? undefined : 2) + "\n");
    return 0;
  } finally { await client.close(); }
}
