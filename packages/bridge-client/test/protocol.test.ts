// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCodes, type ExportResult, type ObjectEntry, type ProjectInfo } from "../src/index.js";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/format/protocol-golden.json", import.meta.url)), "utf8"));

// Compile-time: golden shapes must be assignable to the TS wire types; runtime: keys must be known fields.
const entryKeys: (keyof ObjectEntry)[] = ["address", "kind", "language", "blockType", "number", "namespace", "unit", "knowHowProtected", "isFailsafe", "isSystem", "isConsistent", "fingerprint", "warnings"];
const exportKeys: (keyof ExportResult)[] = ["address", "form", "files", "warnings", "fingerprint", "bundleHash"];
const infoKeys: (keyof ProjectInfo)[] = ["name", "path", "tiaVersion", "devices", "isLocalSession", "units"];

describe("wire protocol golden", () => {
  it("uses only fields the TS types know", () => {
    for (const k of Object.keys(golden.objectEntry)) expect(entryKeys).toContain(k);
    for (const k of Object.keys(golden.objectEntryMinimal)) expect(entryKeys).toContain(k);
    for (const k of Object.keys(golden.exportResult)) expect(exportKeys).toContain(k);
    for (const k of Object.keys(golden.projectInfo)) expect(infoKeys).toContain(k);
    const e: ObjectEntry = golden.objectEntry;
    const r: ExportResult = golden.exportResult;
    const i: ProjectInfo = golden.projectInfo;
    expect([e.address, r.files[1]!.role, i.devices[0]]).toEqual(["plc:PLC_1/blocks/Fx~Überwachung", "companion.s7res", "PLC_1"]);
  });
  it("shares the bridge error codes", () => {
    const bridgeCodes = Object.values(ErrorCodes).filter((c) => !["BRIDGE_EXITED", "TIMEOUT", "PROTOCOL_MISMATCH"].includes(c));
    expect([...bridgeCodes].sort()).toEqual([...golden.errorCodes].sort());
  });
});
