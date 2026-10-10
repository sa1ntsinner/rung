// SPDX-License-Identifier: MIT
import type {TraceModel} from "../core/trace";
import type {RungCli} from "../runner/cli";
import {killTree,startProcess} from "../runner/terminal";

/** CLI validates the portable file; collect stdout separately from capped terminal diagnostics. */
export async function loadTrace(cli:RungCli,path:string,cwd?:string):Promise<TraceModel>{
 const {child,done}=startProcess(cli.invocation(["trace","inspect",path,"--json"]),cwd);
 const decoder=new TextDecoder("utf-8",{fatal:true}),chunks:string[]=[];let bytes=0,failure:Error|undefined;
 const take=(chunk:Buffer)=>{if(failure)return;try{bytes+=chunk.length;if(bytes>64*1024*1024)throw new Error("Trace exceeds 64 MiB");chunks.push(decoder.decode(chunk,{stream:true}));}catch(e){failure=e as Error;killTree(child);}};
 child.stdout?.on("data",take);
 const timer=setTimeout(()=>{failure=new Error("Trace inspection timed out");killTree(child);},60000);timer.unref();
 try{
  const result=await done;if(failure)throw failure;if(result.error)throw result.error;if(result.code!==0)throw new Error(result.output.trim()||"Trace inspection failed");
  chunks.push(decoder.decode());const model=JSON.parse(chunks.join("")) as TraceModel;
  if(!model||model.version!==1||!(model.source==="s7commplus-subscription"&&model.coherence==="asynchronous-observations"||model.source==="tia-long-term-csv"&&model.coherence==="imported-file")||!Array.isArray(model.signals)||model.signals.length<1||model.signals.length>32||model.signals.some(s=>typeof s!=="string"||s.length>1024)||!Array.isArray(model.frames)||model.frames.length>20000)throw new Error("Trace CLI protocol is unsupported");
  return model;
 }finally{clearTimeout(timer);child.stdout?.off("data",take);}
}
