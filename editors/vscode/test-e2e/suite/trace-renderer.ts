// SPDX-License-Identifier: MIT
// Read the actual webview DOM through the isolated acceptance host's loopback debugger.
import * as assert from "node:assert/strict";
import {waitFor} from "./helpers";
export async function traceRenderer(port:number):Promise<{evaluate(expression:string):Promise<any>;close():void}>{
 const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as {url:string;webSocketDebuggerUrl:string}[];
 const page=pages.find(p=>p.url.includes("workbench"));assert.ok(page,"Workbench debugger missing");const socket=new WebSocket(page.webSocketDebuggerUrl);
 let sequence=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>(),contexts:{id:number;session?:string}[]=[];
 const request=(method:string,params:unknown={},session?:string):Promise<any>=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Debugger timeout: ${method}`));},3000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));});
 socket.addEventListener("message",event=>{const m=JSON.parse(String(event.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(m.error.message)):p?.resolve(m.result);}
  if(m.method==="Runtime.executionContextCreated")contexts.push({id:m.params.context.id,session:m.sessionId});
  if(m.method==="Target.attachedToTarget")void request("Runtime.enable",{},m.params.sessionId).catch(()=>{});
 });
 await new Promise<void>((resolve,reject)=>{socket.addEventListener("open",()=>resolve(),{once:true});socket.addEventListener("error",()=>reject(new Error("Debugger connection failed")),{once:true});});
 try{
  await request("Runtime.enable");await request("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
  const targets=await request("Target.getTargets");for(const target of targets.targetInfos)if(target.type==="iframe")await request("Target.attachToTarget",{targetId:target.targetId,flatten:true}).catch(()=>{});
  const context=await waitFor("actual Trace webview DOM",async()=>{for(const c of contexts){try{const result=await request("Runtime.evaluate",{expression:"!!document.querySelector('rg-trace .rg-trace')",contextId:c.id,returnByValue:true},c.session);if(result.result?.value)return c;}catch{}}return false;},20000,100);
  return{evaluate:async expression=>{const r=await request("Runtime.evaluate",{expression,contextId:context.id,returnByValue:true,awaitPromise:true},context.session);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result?.value;},close:()=>socket.close()};
 }catch(e){socket.close();throw e;}
}
