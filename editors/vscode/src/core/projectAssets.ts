// SPDX-License-Identifier: MIT
import {open} from "node:fs/promises";
import {createHash} from "node:crypto";
export async function assetFileHash(path:string,limit:number):Promise<string>{const file=await open(path,"r");try{const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let size=0;for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit)throw new Error("Project asset file exceeds its size limit");hash.update(buffer.subarray(0,bytesRead));}return hash.digest("hex");}finally{await file.close();}}
export interface AssetRequest{action:"hardware"|"library-import"|"library-release"|"library-update"|"alarms"|"technology";device?:string;name?:string;file?:string;typeGuid?:string;versionGuid?:string;number?:string;author?:string;comment?:string;}
function field(request:AssetRequest,key:keyof AssetRequest):string{const value=request[key];if(typeof value!=="string"||!value.trim())throw new Error(`Missing ${key}`);return value;}
export function assetPreviewArgs(request:AssetRequest):string[]{let args:string[];
 switch(request.action){
 case "hardware":return ["hardware","--file",field(request,"file"),"--json"];
 case "library-import":args=["library","--file",field(request,"file"),"--device",field(request,"device")];break;
 case "library-release":args=["library","--release","--type-guid",field(request,"typeGuid"),"--version-guid",field(request,"versionGuid"),"--number",field(request,"number"),"--author",field(request,"author"),"--comment",request.comment??""];break;
 case "library-update":args=["library","--update","--type-guid",field(request,"typeGuid"),"--version-guid",field(request,"versionGuid"),"--device",field(request,"device")];break;
 case "alarms":args=["alarms","--device",field(request,"device"),"--file",field(request,"file")];break;
 case "technology":args=["technology","--device",field(request,"device"),"--name",field(request,"name"),"--file",field(request,"file")];break;
 default:throw new Error("Unknown project asset action");
 }return [...args,"--preview","--json"];
}
export function assetApplyArgs(request:AssetRequest,preview:{revision?:string;artifactRevision?:string;package?:{revision?:string}},fileRevision?:string):string[]{const args=assetPreviewArgs(request).filter(a=>a!=="--preview");args.push("--apply");if(request.action==="hardware"){if(!/^[0-9a-f]{64}$/.test(fileRevision??""))throw new Error("Missing reviewed hardware file hash");args.push("--expected-artifact-revision",fileRevision!);return args;}
 if(!/^[0-9a-f]{64}$/.test(preview.revision??""))throw new Error("Missing reviewed project revision");args.push("--expected-revision",preview.revision!);
 if(request.action==="library-import"){if(!/^[0-9a-f]{64}$/.test(preview.package?.revision??""))throw new Error("Missing package revision");args.push("--expected-package-revision",preview.package!.revision!);}
 if(request.action==="alarms"||request.action==="technology"){if(!/^[0-9a-f]{64}$/.test(preview.artifactRevision??""))throw new Error("Missing artifact revision");args.push("--expected-artifact-revision",preview.artifactRevision!);}return args;
}
