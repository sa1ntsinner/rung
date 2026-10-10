// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {createHash} from "node:crypto";
import { defaultConfig, saveConfig, grantWrites } from "@rung/core";
import * as common from "../src/common.js";
import { main } from "../src/main.js";
afterEach(() => vi.restoreAllMocks());
it("observes safety without enabling writes or inventing an empty signature",async()=>{const root=await mkdtemp(join(tmpdir(),"rung-safety-"));await saveConfig(root,defaultConfig("fixture.ap20","V20","",["PLC_1"]));const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()},request=vi.fn(async()=>({status:"unavailable",reason:"Non-F fixture"})),close=vi.fn(async()=>{});const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({request,close} as never);try{expect(await main(["safety","--device","PLC_1","--json"],io)).toBe(0);expect(request).toHaveBeenCalledWith("safety.observe",{device:"PLC_1"});expect(bridge.mock.calls[0]?.[2]).toBeUndefined();}finally{await rm(root,{recursive:true,force:true});}});
it("previews and explicitly releases library versions with writes and reviewed revision guards",async()=>{
  const root=await mkdtemp(join(tmpdir(),"rung-library-release-"));const config=defaultConfig("fixture.ap20","V20","",["PLC_1"]);await saveConfig(root,config);
  const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()};const request=vi.fn(async()=>({state:"Committed"})),close=vi.fn(async()=>{});
  const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({request,close} as never);
  const args=["library","--release","--type-guid","b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e","--version-guid","51acffde-45c4-45db-a591-a5840bb011af","--number","1.0.0","--author","smile","--comment","Released","--json"];
  try {
    expect(await main([...args,"--preview"],io)).toBe(0);expect(request).toHaveBeenLastCalledWith("library.release.preview",expect.objectContaining({versionNumber:"1.0.0",author:"smile"}));
    bridge.mockClear();expect(await main([...args,"--apply","--expected-revision","a".repeat(64)],io)).toBe(1);expect(bridge).not.toHaveBeenCalled();
    await grantWrites(root,config);expect(await main([...args,"--apply","--expected-revision","a".repeat(64)],io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("library.release",expect.objectContaining({expectedRevision:"a".repeat(64),operationId:expect.stringMatching(/^[0-9a-f-]{36}$/)}));
    expect(await main([...args,"--apply"],io)).toBe(1);expect(await main([...args,"--preview","--file","type.libinfo"],io)).toBe(1);
  }finally{await rm(root,{recursive:true,force:true});}
});
it("exports native alarm bytes and previews complete workbooks through existing write guards",async()=>{
 const root=await mkdtemp(join(tmpdir(),"rung-alarm-artifact-")),config=defaultConfig("fixture.ap20","V20","",["PLC_1"]);await saveConfig(root,config);const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()},request=vi.fn(async()=>({contentBase64:"YWJj",revision:"a".repeat(64)})),close=vi.fn(async()=>{});const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({request,close} as never);
 try{expect(await main(["alarms","--device","PLC_1","--export","native.xlsx"],io)).toBe(0);expect(await readFile(join(root,"native.xlsx"))).toEqual(Buffer.from("abc"));expect(await main(["alarms","--device","PLC_1","--file","native.xlsx","--preview"],io)).toBe(0);expect(request).toHaveBeenLastCalledWith("artifact.preview",{kind:"alarms",device:"PLC_1",contentBase64:"YWJj"});bridge.mockClear();expect(await main(["alarms","--device","PLC_1","--file","native.xlsx","--apply","--expected-revision","a".repeat(64),"--expected-artifact-revision","b".repeat(64)],io)).toBe(1);expect(bridge).not.toHaveBeenCalled();await grantWrites(root,config);expect(await main(["technology","--device","PLC_1","--name","PID","--file","native.xlsx","--apply","--expected-revision","a".repeat(64),"--expected-artifact-revision","b".repeat(64)],io)).toBe(0);expect(request).toHaveBeenLastCalledWith("artifact.import",expect.objectContaining({kind:"technology",name:"PID",operationId:expect.any(String)}));}
 finally{await rm(root,{recursive:true,force:true});}
});
it("previews and applies explicit library default updates with write guards",async()=>{
 const root=await mkdtemp(join(tmpdir(),"rung-library-update-")),config=defaultConfig("fixture.ap20","V20","",["PLC_1"]);await saveConfig(root,config);
 const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()},request=vi.fn(async()=>({revision:"a".repeat(64)})),close=vi.fn(async()=>{});const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({request,close} as never);
 try{const args=["library","--update","--type-guid","b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e","--version-guid","51acffde-45c4-45db-a591-a5840bb011af","--device","PLC_1"];
 expect(await main([...args,"--preview"],io)).toBe(0);expect(request).toHaveBeenLastCalledWith("library.update.preview",expect.objectContaining({device:"PLC_1"}));
 bridge.mockClear();expect(await main([...args,"--apply","--expected-revision","a".repeat(64)],io)).toBe(1);expect(bridge).not.toHaveBeenCalled();await grantWrites(root,config);
 expect(await main([...args,"--apply","--expected-revision","a".repeat(64)],io)).toBe(0);expect(request).toHaveBeenLastCalledWith("library.update",expect.objectContaining({operationId:expect.any(String)}));
 }finally{await rm(root,{recursive:true,force:true});}
});
it("makes a master copy of a block and a block from a master copy through the write guards",async()=>{
 const root=await mkdtemp(join(tmpdir(),"rung-master-copy-")),config=defaultConfig("fixture.ap20","V20","",["PLC_1"]);await saveConfig(root,config);
 const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()},request=vi.fn(async()=>({revision:"a".repeat(64)})),close=vi.fn(async()=>{});const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({request,close} as never);
 try{
  expect(await main(["library","--master-copy","Motor template","--from","Motor","--device","PLC_1","--preview"],io)).toBe(0);
  expect(request).toHaveBeenLastCalledWith("library.mastercopy.preview",{action:"create",name:"Motor template",device:"PLC_1",block:"Motor"});
  bridge.mockClear();expect(await main(["library","--master-copy","Motor template","--device","PLC_1","--apply","--expected-revision","a".repeat(64)],io)).toBe(1);expect(bridge).not.toHaveBeenCalled();
  await grantWrites(root,config);
  expect(await main(["library","--master-copy","Motor template","--device","PLC_1","--apply","--expected-revision","a".repeat(64)],io)).toBe(0);
  expect(request).toHaveBeenLastCalledWith("library.mastercopy",expect.objectContaining({action:"use",name:"Motor template",operationId:expect.any(String)}));
  expect(await main(["library","--master-copy","Motor template","--preview"],io)).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});
it("applies library packages only with reviewed revisions and workspace writes enabled", async () => {
  const root=await mkdtemp(join(tmpdir(),"rung-library-import-"));
  const config=defaultConfig("fixture.ap20","V20","",["PLC_1"]);await saveConfig(root,config);
  const io={ cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn() };
  const request=vi.fn(async()=>({ state:"InWork" })),close=vi.fn(async()=>{});
  const bridge=vi.spyOn(common,"bridgeFor").mockResolvedValue({ request,close } as never);
  try {
    await writeFile(join(root,"type.libinfo"),"{}\n");await writeFile(join(root,"type.xml"),"\uFEFF<Document/>\n");
    const args=["library","--file","type.libinfo","--apply","--expected-revision","a".repeat(64),"--expected-package-revision","b".repeat(64),"--json"];
    expect(await main(args,io)).toBe(1);expect(bridge).not.toHaveBeenCalled();
    await grantWrites(root,config);
    expect(await main(args,io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("library.import",expect.objectContaining({ device:"PLC_1",expectedRevision:"a".repeat(64),
      expectedPackageRevision:"b".repeat(64),operationId:expect.stringMatching(/^[0-9a-f-]{36}$/) }));
    expect(bridge.mock.calls.at(-1)?.[2]).toContain("--allow-import");
    bridge.mockClear();expect(await main(["library","--file","type.libinfo","--apply"],io)).toBe(1);expect(bridge).not.toHaveBeenCalled();
  } finally { await rm(root,{ recursive:true,force:true }); }
});
it("lists native GUIDs and exports raw library files without overwriting an existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-library-export-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  const io = { cwd: root, env: {}, stdout: vi.fn(), stderr: vi.fn() };
  const xml = Buffer.from("\uFEFF<Document/>\r\n"), metadata = Buffer.from("{}\r\n");
  const request = vi.fn(async (method: string) => method === "model.describe" ? { children: {} } : { metadata: { typeName: "proof" }, files: [
    { name: "type.xml", contentBase64: xml.toString("base64") }, { name: "type.libinfo", contentBase64: metadata.toString("base64") },
  ] });
  const close = vi.fn(async () => {}); vi.spyOn(common, "bridgeFor").mockResolvedValue({ request, close } as never);
  try {
    expect(await main(["library", "--json"], io)).toBe(0);
    expect(request).toHaveBeenCalledWith("model.describe", { scope: "libraries", maxNodes: 4096 });
    const args = ["library", "--type-guid", "b2e48f13-0a47-4cb5-b40c-7bdd5f8ff50e", "--version-guid", "51acffde-45c4-45db-a591-a5840bb011af", "--export", "native", "--json"];
    expect(await main(args, io)).toBe(0);
    expect(await readFile(join(root, "native", "type.xml"))).toEqual(xml);
    request.mockClear(); expect(await main(args, io)).toBe(1); expect(request).not.toHaveBeenCalled();
    expect(await readFile(join(root, "native", "type.xml"))).toEqual(xml);
    request.mockResolvedValue({ metadata: {}, files: [
      { name: "../escape.xml", contentBase64: xml.toString("base64") }, { name: "type.libinfo", contentBase64: metadata.toString("base64") },
    ] });
    expect(await main(args.map(a => a === "native" ? "refused" : a), io)).toBe(1);
    await expect(readFile(join(root, "refused", "type.xml"))).rejects.toThrow();
    expect(await main(["library", "--file", "type.libinfo", "--type-guid", args[2]!], io)).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("inspects a native library pair as raw bytes and refuses oversized files before opening the bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-library-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  const output: string[] = [];
  const io = { cwd: root, env: {}, stdout: (s: string) => output.push(s), stderr: (s: string) => output.push(s) };
  const close = vi.fn(async () => {}), request = vi.fn(async () => ({ typeName: "Fx_LadEdges" }));
  const bridge = vi.spyOn(common, "bridgeFor").mockResolvedValue({ close, request } as never);
  const xml = Buffer.from("\uFEFF<Document/>\r\n", "utf8"), meta = Buffer.from("{}\r\n");
  try {
    await writeFile(join(root, "type.xml"), xml); await writeFile(join(root, "type.libinfo"), meta);
    expect(await main(["library", "--file", "type.libinfo", "--json"], io)).toBe(0);
    expect(request).toHaveBeenCalledWith("library.inspect", { stem: "type", files: [
      { name: "type.libinfo", contentBase64: meta.toString("base64") }, { name: "type.xml", contentBase64: xml.toString("base64") },
    ] }); expect(close).toHaveBeenCalledTimes(1);
    expect(await main(["library", "--file", "type.libinfo", "--preview", "--device", "PLC_1", "--json"], io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("library.preview", { stem: "type", device: "PLC_1", files: [
      { name: "type.libinfo", contentBase64: meta.toString("base64") }, { name: "type.xml", contentBase64: xml.toString("base64") },
    ] });
    bridge.mockClear(); await writeFile(join(root, "type.xml"), Buffer.alloc(4*1024*1024+1));
    expect(await main(["library", "--file", "type.libinfo"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("snapshots and previews hardware through read-only RPC and closes its session", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-hardware-"));
  await saveConfig(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
  const out: string[] = [], errors: string[] = [];
  const io = { cwd: root, env: {}, stdout: (s: string) => out.push(s), stderr: (s: string) => errors.push(s) };
  const close = vi.fn(async () => {}), request = vi.fn(async (method: string) => method === "hardware.snapshot" ? { version: 1, revision: "r", tree: {} } : { revision: "r", changes: [] });
  const bridge = vi.spyOn(common, "bridgeFor").mockResolvedValue({ close, request } as never);
  try {
    expect(await main(["hardware", "--json"], io)).toBe(0);
    expect(request.mock.calls[0]?.[0]).toBe("hardware.snapshot"); expect(close).toHaveBeenCalledTimes(1);
    const text = '{"version":1,"version":1,"expectedRevision":"r","changes":[]}';
    await writeFile(join(root, "patch.json"), text);
    expect(await main(["hardware", "--file", "patch.json", "--json"], io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("hardware.preview", { patchText: text }); expect(close).toHaveBeenCalledTimes(2);
    await writeFile(join(root, "patch.yaml"), "version: 1\nexpectedRevision: r\nchanges: []\n");
    expect(await main(["hardware", "--file", "patch.yaml", "--json"], io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("hardware.preview", { patchText: JSON.stringify({ version: 1, expectedRevision: "r", changes: [] }) });
    bridge.mockClear();
    await writeFile(join(root, "patch.yaml"), "version: 1\nversion: 2\nchanges: []\n");
    expect(await main(["hardware", "--file", "patch.yaml"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
    bridge.mockClear();
    expect(await main(["hardware", "--file", "patch.json", "--apply"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
    await grantWrites(root, defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]));
    expect(await main(["hardware","--file","patch.json","--apply","--expected-artifact-revision","a".repeat(64)],io)).toBe(1);
    bridge.mockClear();
    expect(await main(["hardware","--file","patch.json","--apply","--expected-artifact-revision",createHash("sha256").update(text).digest("hex")],io)).toBe(0);
    expect(await main(["hardware", "--file", "patch.json", "--apply", "--json"], io)).toBe(0);
    expect(request).toHaveBeenLastCalledWith("hardware.apply", { patchText: text, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(bridge.mock.calls.at(-1)?.[2]).toContain("--allow-import");
    bridge.mockClear();
    expect(await main(["hardware", "--apply"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
    bridge.mockClear(); await writeFile(join(root, "patch.json"), "bad json");
    expect(await main(["hardware", "--file", "patch.json"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
    await writeFile(join(root, "patch.json"), " ".repeat(1048577));
    expect(await main(["hardware", "--file", "patch.json"], io)).toBe(1); expect(bridge).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
