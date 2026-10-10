// SPDX-License-Identifier: BUSL-1.1
import {open} from "node:fs/promises";
import {resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {WorkspaceError} from "@rung/core";
import {TraceRecorder,parseTrace,parseTraceCsv,parseTraceCsvFile,TRACE_MAX_BYTES,type TraceRecording,type TraceCsvFile,type TraceCsvView} from "@rung/live";
import {brokerReader,liveSelection} from "./liveServer.js";
import {findWorkspace,readBoundedBytes,type Io} from "./common.js";
import type {LiveReader} from "./live.js";

export interface TraceOptions{device?:string;out?:string;duration?:string;interval?:string;json?:boolean;parentStdio?:boolean;}
export async function cmdTrace(dir:string,action:string|undefined,args:string[],io:Io,options:TraceOptions):Promise<number>{
 if(action==="inspect"){
  if(args.length!==1||options.out||options.device||options.duration||options.interval||options.parentStdio)throw new WorkspaceError("BAD_ARGUMENT","trace inspect requires one recording file and optional --json");
  let trace:TraceRecording|TraceCsvView;
  try{const text=new TextDecoder("utf-8",{fatal:true}).decode(await readBoundedBytes(resolve(io.cwd,args[0]!),"Trace",TRACE_MAX_BYTES));trace=JSON.parse(text)?.source==="tia-long-term-csv"?parseTraceCsvFile(text):parseTrace(text);}
  catch(error){throw new WorkspaceError("BAD_ARGUMENT",`Cannot inspect trace: ${error instanceof Error?error.message:String(error)}`);}
  io.stdout(options.json?JSON.stringify(trace)+"\n":`Trace: ${trace.signals.length} signals, ${trace.frames.length} observations, ${trace.stopReason}; ${trace.coherence}; cycle timing not verified\n`);return 0;
 }
 if(action==="import"){
  if(args.length!==1||!options.out||options.device||options.duration||options.interval||options.parentStdio)throw new WorkspaceError("BAD_ARGUMENT","trace import <TIA-long-term.csv> --out <new.json> [--json]");
  const path=resolve(io.cwd,options.out);
  try{
   const csv=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(await readBoundedBytes(resolve(io.cwd,args[0]!),"Trace CSV",TRACE_MAX_BYTES)),view=parseTraceCsv(csv);
   const portable:TraceCsvFile={version:1,source:"tia-long-term-csv",sourceSha256:view.sourceSha256,csv},data=JSON.stringify(portable)+"\n";
   if(Buffer.byteLength(data)>TRACE_MAX_BYTES)throw new Error("Portable CSV trace size limit exceeded");
   const file=await open(path,"wx");try{await file.writeFile(data);}finally{await file.close();}
   io.stdout(options.json?JSON.stringify({path,frames:view.frames.length,signals:view.signals.length,sourceSha256:view.sourceSha256,coherence:view.coherence})+"\n":`Imported ${view.frames.length} native CSV rows to ${path}; signal types and cycle timing not verified\n`);return 0;
  }catch(error){throw new WorkspaceError("BAD_ARGUMENT",`Cannot import trace: ${error instanceof Error?error.message:String(error)}; any newly created output may be incomplete`);}
 }
 if(action!=="record")throw new WorkspaceError("BAD_ARGUMENT","trace record <signal>... --device <PLC> --out <new.json> --duration <seconds>, trace inspect <file>, or trace import <TIA.csv> --out <new.json>");
 const duration=Number(options.duration??60),interval=Number(options.interval??100);
 if(!options.device||!options.out||!Number.isInteger(duration)||duration<1||duration>3600)throw new WorkspaceError("BAD_ARGUMENT","Trace requires --device, --out and duration 1–3600 seconds");
 let recorder:TraceRecorder;
 try{recorder=new TraceRecorder(args,interval,Date.now());}catch(error){throw new WorkspaceError("BAD_ARGUMENT",`${error instanceof Error?error.message:String(error)}; use 1–32 distinct signals and interval 100–60000 ms`);}
 const root=await findWorkspace(dir),selected=await liveSelection(root,{device:options.device});
 if(selected.transport!=="s7commplus")throw new WorkspaceError("BAD_ARGUMENT","Trace recording through Web API is not supported; use live read/watch, or configure an S7CommPlus target for trace record");
 const path=resolve(io.cwd,options.out),file=await open(path,"wx").catch(error=>{throw new WorkspaceError("BAD_ARGUMENT",`Cannot create new trace file ${path}: ${error.message}`);});
 let reader:LiveReader|undefined,lease:{close():Promise<void>}|undefined,closing:Promise<void>|undefined,timer:NodeJS.Timeout|undefined;
 let started=performance.now(),active=true,opening=false,stopped=false,failure:unknown,reason:TraceRecording["stopReason"]="duration";
 let done!:()=>void;const ended=new Promise<void>(r=>done=r);
 const stop=(why:TraceRecording["stopReason"])=>{if(!stopped){stopped=true;reason=why;done();}};
 const closeReader=()=>closing??=(reader?.close()??Promise.resolve());
 const interrupt=()=>{stop("stopped");if(opening)void closeReader().catch(error=>failure??=error);};
 if(io.stopSignal)void io.stopSignal.then(interrupt);else process.once("SIGINT",interrupt);
 const input=options.parentStdio?process.stdin:undefined;if(input){input.once("end",interrupt);input.once("close",interrupt);input.resume();if(input.readableEnded||input.destroyed)interrupt();}
 try{
  if(!stopped){reader=await brokerReader(root,io.env,{device:options.device,transport:"s7commplus"});if(!reader.subscribe)throw new Error("Trace requires subscription support");
   if(!stopped){started=performance.now();recorder=new TraceRecorder(args,interval,Date.now());timer=setTimeout(()=>{stop("duration");if(opening)void closeReader().catch(error=>failure??=error);},duration*1000);opening=true;try{lease=await reader.subscribe(Object.fromEntries(args.map(s=>[s,s])),interval,frame=>{if(!active||stopped)return;try{
    if(frame.scope.device!==selected.device||frame.scope.address!==selected.target.address||frame.scope.transport!=="s7commplus")throw new Error("Trace target differs from selected PLC");
    const elapsed=performance.now()-started;if(elapsed>=duration*1000){stop("duration");return;}
    if(!recorder.append(frame,elapsed))stop("capacity");
   }catch(error){failure=error;stop("error");}});}catch(error){if(!stopped)throw error;}finally{opening=false;}
   }
  }
  await ended;
 }catch(error){failure=error;stop("error");}
 finally{
  active=false;clearTimeout(timer);process.removeListener("SIGINT",interrupt);input?.removeListener("end",interrupt);input?.removeListener("close",interrupt);input?.pause();
  try{await lease?.close();}catch(error){failure??=error;}try{await closeReader();}catch(error){failure??=error;}
 }
 const trace=recorder.finish(failure?"error":reason);
 try{try{const data=JSON.stringify(trace);if(Buffer.byteLength(data)+1>TRACE_MAX_BYTES)throw new Error("Trace file size limit exceeded");await file.writeFile(data+"\n");}finally{await file.close();}}
 catch(error){io.stderr(`rung: Trace could not be saved to ${path}: ${error instanceof Error?error.message:String(error)}; the file may be incomplete\n`);return 1;}
 if(failure){io.stderr(`rung: Trace failed: ${failure instanceof Error?failure.message:String(failure)}; partial recording saved to ${path}\n`);return 1;}
 io.stdout(options.json?JSON.stringify({path,frames:trace.frames.length,signals:trace.signals.length,stopReason:trace.stopReason,coherence:trace.coherence})+"\n":`Saved ${trace.frames.length} observations to ${path} (${trace.stopReason}; asynchronous, not cycle-exact)\n`);return 0;
}
