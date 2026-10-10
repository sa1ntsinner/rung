// SPDX-License-Identifier: BUSL-1.1
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadConfig, WorkspaceError } from "@rung/core";
import { bridgeFor, findWorkspace, readBoundedBytes, type Io } from "./common.js";
export async function cmdSafety(dir:string,device:string,io:Io,json:boolean):Promise<number>{if(!device||device.length>128||/\p{Cc}/u.test(device))throw new WorkspaceError("BAD_ARGUMENT","Safety observation requires one PLC");const config=await loadConfig(await findWorkspace(dir));const client=await bridgeFor(config,io);try{io.stdout(JSON.stringify(await client.request("safety.observe",{device}),null,json?undefined:2)+"\n");return 0;}finally{await client.close();}}
export async function cmdProjectArtifact(kind:"alarms"|"technology",dir:string,io:Io,options:{device?:string;name?:string;exportPath?:string;files?:string[];preview?:boolean;apply?:boolean;expectedRevision?:string;expectedArtifactRevision?:string;json?:boolean}):Promise<number>{
 const exporting=options.exportPath!==undefined;
 if(!options.device||(kind==="technology"?!options.name:options.name!==undefined)|| (exporting?!!options.files?.length||options.preview||options.apply:options.files?.length!==1||!!options.preview===!!options.apply)
  ||(options.apply?!/^[0-9a-f]{64}$/.test(options.expectedRevision??"")||!/^[0-9a-f]{64}$/.test(options.expectedArtifactRevision??""):options.expectedRevision!==undefined||options.expectedArtifactRevision!==undefined))throw new WorkspaceError("BAD_ARGUMENT","Choose a native export or one file with preview/apply, explicit PLC and technology name; apply requires both reviewed hashes");
 const config=await loadConfig(await findWorkspace(dir));if(!["V19","V20","V21"].includes(config.project.tiaVersion))throw new WorkspaceError("BAD_ARGUMENT","Native project artifacts needs TIA Portal V19, V20 or V21");if(options.apply&&(config.writesOff||config.sync.import!=="auto"))throw new WorkspaceError("WRITES_OFF","Artifact import requires writes on and sync.import = auto");
 const bytes=exporting?undefined:await readBoundedBytes(resolve(io.cwd,options.files![0]!),"Native project artifact",4*1048576);
 const client=await bridgeFor(config,io,options.apply?["--allow-import",...(config.sync.save==="after-import"?["--save-after-import"]:[])]:[]);
 try{const result=await client.request(exporting?"artifact.export":options.apply?"artifact.import":"artifact.preview",{kind,device:options.device,...(options.name?{name:options.name}:{}),...(bytes?{contentBase64:bytes.toString("base64")}:{}),...(options.apply?{expectedRevision:options.expectedRevision,expectedArtifactRevision:options.expectedArtifactRevision,operationId:randomUUID()}: {})}) as {contentBase64?:string;revision?:string;[key:string]:unknown};
  if(exporting){const encoded=result.contentBase64;if(typeof encoded!=="string"||encoded.length>5592408)throw new WorkspaceError("BAD_ARGUMENT","Invalid native artifact response");const raw=Buffer.from(encoded,"base64");if(raw.length===0||raw.length>4*1048576||raw.toString("base64")!==encoded)throw new WorkspaceError("BAD_ARGUMENT","Invalid native artifact bytes");const path=resolve(io.cwd,options.exportPath!);await writeFile(path,raw,{flag:"wx"});const {contentBase64:_,...metadata}=result;io.stdout(JSON.stringify({path,...metadata},null,options.json?undefined:2)+"\n");}
  else io.stdout(JSON.stringify(result,null,options.json?undefined:2)+"\n");return 0;
 }finally{await client.close();}
}
