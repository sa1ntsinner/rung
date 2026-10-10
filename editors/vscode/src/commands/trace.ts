// SPDX-License-Identifier: MIT
import {basename,join,resolve} from "node:path";
import type {ChildProcess} from "node:child_process";
import * as vscode from "vscode";
import {assetFileHash} from "../core/projectAssets";
import {RungCli} from "../runner/cli";
import {startProcess,stopLive} from "../runner/terminal";
import type {RungWorkspace} from "../workspace";
import {loadTrace} from "../trace/loader";
import {TracePanel} from "../trace/panel";
import type {Connector} from "./connect";
import {deviceTarget} from "./targets";

interface RecordOptions{signals?:string[];device?:string;duration?:number;interval?:number;out?:string;}
function validate(options:RecordOptions):void{
 if(options.signals!==undefined&&(!Array.isArray(options.signals)||options.signals.length<1||options.signals.length>32||options.signals.some(s=>typeof s!=="string"||!s.trim()||s.length>1024||/[\x00-\x1f\x7f]/.test(s))||new Set(options.signals.map(s=>s.toLowerCase())).size!==options.signals.length))throw new Error("Select 1–32 distinct signal names");
 for(const [key,min,max] of [["duration",1,3600],["interval",100,60000]] as const){const value=options[key];if(value!==undefined&&(!Number.isInteger(value)||value<min||value>max))throw new Error(`Trace ${key} must be an integer from ${min} to ${max}`);}
 for(const key of ["device","out"] as const)if(options[key]!==undefined&&(typeof options[key]!=="string"||!options[key]!.trim()||/[\x00-\x1f\x7f]/.test(options[key]!)))throw new Error(`Invalid trace ${key}`);
}
export class TraceCommands implements vscode.Disposable{
 private child:ChildProcess|undefined;private busy=false;private disposed=false;
 constructor(private readonly ctx:vscode.ExtensionContext,private readonly ws:RungWorkspace,private readonly cli:RungCli,private readonly connector:Connector){}
 private async show(path:string):Promise<void>{const model=await loadTrace(this.cli,path,this.ws.root);if(!this.disposed)TracePanel.show(this.ctx,model,basename(path));}
 async open(arg?:unknown):Promise<void>{try{const path=typeof arg==="string"?arg:arg instanceof vscode.Uri&&arg.scheme==="file"?arg.fsPath:(await vscode.window.showOpenDialog({canSelectMany:false,filters:{"Trace JSON":["json"]},title:"Open rung trace"}))?.[0]?.fsPath;if(path)await this.show(path);}catch(e){void vscode.window.showErrorMessage((e as Error).message);}}
 async importCsv():Promise<void>{try{
  const source=(await vscode.window.showOpenDialog({canSelectMany:false,filters:{"TIA long-term CSV":["csv"]},title:"Import TIA long-term CSV"}))?.[0];if(!source)return;
  const target=await vscode.window.showSaveDialog({filters:{"Trace JSON":["json"]},title:"Save imported trace as a new file"});if(!target)return;
  const result=await this.cli.capture(["trace","import",source.fsPath,"--out",target.fsPath,"--json"]);if(result.code!==0||result.error)throw new Error(result.error?.message||RungCli.summary(result.output));await this.show(target.fsPath);
 }catch(e){void vscode.window.showErrorMessage((e as Error).message);}}
 async record(arg?:unknown):Promise<void>{
  if(this.busy){void vscode.window.showInformationMessage("A trace recording is already running.");return;}if(this.disposed)return;this.busy=true;
  let sub:vscode.Disposable|undefined;
  try{
   if(arg!==undefined&&(!arg||typeof arg!=="object"||Array.isArray(arg)))throw new Error("Invalid trace options");const options=(arg??{}) as RecordOptions;validate(options);
   const root=this.ws.root;if(!root||!this.ws.hasConfig)throw new Error("Open a rung workspace before recording");const config=join(root,"rung.toml"),revision=await assetFileHash(config,1048576);
   const device=options.device??await deviceTarget(this.ws,undefined,"record trace");if(!device)return;
   const input=options.signals?undefined:await vscode.window.showInputBox({title:"Trace signals",prompt:"Comma-separated symbolic names (up to 32)",placeHolder:"ProveOps_DB.a, ProveOps_DB.sum"});if(!options.signals&&input===undefined)return;
   const signals=options.signals??input!.split(",").map(s=>s.trim());
   const durationText=options.duration===undefined?await vscode.window.showInputBox({title:"Trace duration",prompt:"Seconds (1–3600)",value:"60",validateInput:v=>/^\d+$/.test(v)&&Number(v)>=1&&Number(v)<=3600?undefined:"Enter 1–3600 whole seconds"}):undefined;if(options.duration===undefined&&durationText===undefined)return;
   const duration=options.duration??Number(durationText),interval=options.interval??100;
   const target=options.out?resolve(root,options.out):(await vscode.window.showSaveDialog({title:"Save trace as a new file",filters:{"Trace JSON":["json"]}}))?.fsPath;if(!target)return;
   validate({signals,device,duration,interval,out:target});const env=await this.connector.passwordEnv(device);
   if(this.disposed)return;if(this.ws.root!==root||await assetFileHash(config,1048576)!==revision)throw new Error("Workspace or configuration changed while preparing trace");
   let stopped=false,changed=false,finished=false;const stop=()=>{if(!stopped&&this.child){stopped=true;stopLive(this.child,30000);}};
   sub=this.ws.onDidChange(()=>{void (async()=>{try{if(this.ws.root!==root||await assetFileHash(config,1048576)!==revision){if(!finished){changed=true;stop();}}}catch{if(!finished){changed=true;stop();}}})();});
   const args=["trace","record",...signals,"--device",device,"--dir",root,"--duration",String(duration),"--interval",String(interval),"--out",target,"--json","--parent-stdio"];
   const process=startProcess(this.cli.invocation(args),root,undefined,env,true);this.child=process.child;
   // The recorder may flush 64 MiB; allow more grace than a live value reader.
   const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Recording ${device} · ${duration}s (asynchronous observations)`,cancellable:true},async(_progress,token)=>{const cancel=token.onCancellationRequested(stop);if(token.isCancellationRequested)stop();try{return await process.done;}finally{cancel.dispose();finished=true;}});
   if(result.error||result.code!==0)throw new Error(`${result.error?.message||RungCli.summary(result.output)}. Any partial recording is at ${target}`);
   if(changed&&!this.disposed)void vscode.window.showInformationMessage("Trace stopped and saved because the workspace or configuration changed.");await this.show(target);
  }catch(e){if(!this.disposed)void vscode.window.showErrorMessage((e as Error).message);}finally{sub?.dispose();if(this.child?.exitCode===null)stopLive(this.child,30000);this.child=undefined;this.busy=false;}
 }
 dispose():void{this.disposed=true;if(this.child)stopLive(this.child,30000);}
}
