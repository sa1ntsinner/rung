// SPDX-License-Identifier: MIT
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {expect,it,vi} from "vitest";
vi.mock("../src/runner/terminal",()=>({startProcess:vi.fn(),killTree:vi.fn()}));
import {startProcess,killTree} from "../src/runner/terminal";
import {loadTrace} from "../src/trace/loader";
import type {RungCli} from "../src/runner/cli";
function processFor(text:string,code=0){
 const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});
 vi.mocked(startProcess).mockImplementationOnce(()=>{const done=new Promise(resolve=>setTimeout(()=>{const bytes=Buffer.from(text);for(let i=0;i<bytes.length;i+=65537)child.stdout.write(bytes.subarray(i,i+65537));child.stdout.end();resolve({code,output:"diagnostic on stderr"});},0));return {child,done} as unknown as ReturnType<typeof startProcess>;});
 return child;
}
const cli={invocation:vi.fn(()=>({file:"rung",args:[],display:"rung"}))} as unknown as RungCli;
const trace={version:1,source:"s7commplus-subscription",coherence:"asynchronous-observations",startedAt:0,intervalMs:100,signals:["速度"],frames:[],stopReason:"stopped"};
it("loads output beyond the terminal capture limit and preserves split UTF8, separate from stderr",async()=>{
 const frames=Array.from({length:10000},(_,i)=>({elapsedMs:i*100,sourceAt:i*100,scope:{device:"PLC",address:"127.0.0.1",transport:"s7commplus",epoch:0},state:"live",cells:{速度:{value:null,error:"🙂".repeat(100)}}}));
 const text=JSON.stringify({...trace,frames});processFor(text);
 const loaded=await loadTrace(cli,"C:/trace.json");expect(loaded.signals[0]).toBe("速度");expect(loaded.frames[9999]!.cells["速度"]!.error).toBe("🙂".repeat(100));expect(cli.invocation).toHaveBeenLastCalledWith(["trace","inspect","C:/trace.json","--json"]);
});
it("refuses failed commands, wrong protocol and malformed UTF8",async()=>{
 processFor(JSON.stringify(trace),1);await expect(loadTrace(cli,"bad")).rejects.toThrow(/diagnostic/);
 processFor('{"version":9}');await expect(loadTrace(cli,"bad")).rejects.toThrow(/Trace/);
 const child=processFor("");const pending=loadTrace(cli,"bad");child.stdout.write(Buffer.from([0xff]));await expect(pending).rejects.toThrow(/UTF|encoded|encoding/i);expect(killTree).toHaveBeenCalledWith(child);
});
