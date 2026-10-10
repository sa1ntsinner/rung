// SPDX-License-Identifier: MIT
import {expect,it} from "vitest";
import {assetPreviewArgs,assetApplyArgs,assetFileHash} from "../src/core/projectAssets";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
it("bounds streamed artifact hashes without allocating the file",async()=>{const path=join(mkdtempSync(join(tmpdir(),"rung-hash-")),"artifact");writeFileSync(path,Buffer.alloc(65537));await expect(assetFileHash(path,65536)).rejects.toThrow(/size limit/);await expect(assetFileHash(path,65537)).resolves.toMatch(/^[0-9a-f]{64}$/);});
it("builds reviewed native workflows without silently changing scope or versions",()=>{
 const alarm={action:"alarms" as const,device:"PLC_1",file:"alarms.xlsx"};expect(assetPreviewArgs(alarm)).toEqual(["alarms","--device","PLC_1","--file","alarms.xlsx","--preview","--json"]);
 expect(assetApplyArgs(alarm,{revision:"a".repeat(64),artifactRevision:"b".repeat(64)})).toContain("--expected-artifact-revision");
 expect(()=>assetApplyArgs(alarm,{revision:"a".repeat(64)})).toThrow();
 expect(assetPreviewArgs({action:"library-release",typeGuid:"t",versionGuid:"v",number:"1.0.0",author:"smile",comment:"Reviewed"})).toEqual(["library","--release","--type-guid","t","--version-guid","v","--number","1.0.0","--author","smile","--comment","Reviewed","--preview","--json"]);
 expect(assetApplyArgs({action:"library-import",device:"PLC_1",file:"type.libinfo"},{revision:"a".repeat(64),package:{revision:"b".repeat(64)}})).toContain("--expected-package-revision");
});
