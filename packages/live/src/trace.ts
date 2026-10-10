// SPDX-License-Identifier: BUSL-1.1
import type {LiveFrame,LiveScope} from "./types.js";

export const TRACE_MAX_BYTES=64*1048576,TRACE_MAX_FRAMES=20000;
export interface TraceCell {value:number|boolean|null;observedAt?:number;type?:string;error?:string;}
export interface TraceFrame {elapsedMs:number;sourceAt:number;scope:LiveScope;state:LiveFrame["state"];cells:Record<string,TraceCell>;}
export interface TraceRecording {version:1;source:"s7commplus-subscription";coherence:"asynchronous-observations";startedAt:number;intervalMs:number;signals:string[];frames:TraceFrame[];stopReason:"duration"|"stopped"|"capacity"|"error";}
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v);
const timestamp=(v:unknown):v is number=>finite(v)&&v>=0&&v<=8640000000000000;
function signalsValid(signals:unknown):signals is string[]{return Array.isArray(signals)&&signals.length>0&&signals.length<=32&&signals.every(s=>typeof s==="string"&&s.trim()&&s.length<=1024&&!/[\x00-\x1f\x7f]/.test(s))&&new Set(signals.map(s=>s.toLowerCase())).size===signals.length;}
function scopeValid(scope:LiveScope):boolean{return !!scope&&typeof scope.device==="string"&&scope.device.length>0&&scope.device.length<=1024&&typeof scope.address==="string"&&scope.address.length>0&&scope.address.length<=1024&&scope.transport==="s7commplus"&&Number.isSafeInteger(scope.epoch)&&scope.epoch>=0;}
const states=["connecting","live","stale","disconnected"];
function fields(value:unknown,allowed:string[],required:string[]=allowed):asserts value is Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw new Error("Invalid trace fields");}

export class TraceRecorder {
 private readonly frames:TraceFrame[]=[];
 private readonly signals:string[];
 private bytes=65536;
 private capacity=false;
 constructor(signals:string[],private readonly intervalMs:number,private readonly startedAt:number){if(!signalsValid(signals)||!Number.isInteger(intervalMs)||intervalMs<100||intervalMs>60000||!timestamp(startedAt))throw new Error("Invalid trace signals, interval or start time");this.signals=[...signals];this.bytes+=new TextEncoder().encode(JSON.stringify(signals)).length;}
 append(frame:LiveFrame,elapsedMs:number):boolean{
  if(this.capacity)return false;
  if(!timestamp(elapsedMs)||elapsedMs>3600000||(this.frames.at(-1)?.elapsedMs??0)>elapsedMs)throw new Error("Invalid trace elapsed time");
  if(!timestamp(frame.at)||!scopeValid(frame.scope)||!states.includes(frame.state))throw new Error("Invalid trace frame scope/state/time");
  const previous=this.frames.at(-1);if(previous&&(frame.scope.device!==previous.scope.device||frame.scope.address!==previous.scope.address||frame.scope.transport!==previous.scope.transport))throw new Error("Trace target changed");
  if(previous&&frame.scope.epoch<previous.scope.epoch)throw new Error("Obsolete trace epoch");
  const clockRegressed=previous&&frame.at<previous.sourceAt;
  const cells=Object.fromEntries(this.signals.map(name=>{const value=frame.values[name],at=frame.observedAt[name],type=frame.types?.[name];let error=frame.errors[name];
   if(clockRegressed)error="Host clock regressed";else if(frame.state!=="live")error=`PLC ${frame.state}`;else if(!error&&!Object.hasOwn(frame.values,name))error="Signal not observed";else if(!error&&!(typeof value==="boolean"||finite(value)))error="Unsupported/nonfinite scalar";else if(!error&&(!timestamp(at)||at>frame.at))error="Invalid signal observation time";
   const cell:TraceCell={value:error?null:value as number|boolean,...(timestamp(at)?{observedAt:at}:{}),...(typeof type==="string"?{type:type.slice(0,256)}:{}),...(error?{error:error.slice(0,4096)}:{})};return [name,cell];}));
  const sample:TraceFrame={elapsedMs,sourceAt:frame.at,scope:{device:frame.scope.device,address:frame.scope.address,transport:frame.scope.transport,epoch:frame.scope.epoch},state:frame.state,cells};
  const size=new TextEncoder().encode(JSON.stringify(sample)).length+1;if(this.bytes+size>TRACE_MAX_BYTES){this.capacity=true;return false;}this.bytes+=size;this.frames.push(sample);if(this.frames.length>=TRACE_MAX_FRAMES)this.capacity=true;return !this.capacity;
 }
 finish(reason:TraceRecording["stopReason"]):TraceRecording{return {version:1,source:"s7commplus-subscription",coherence:"asynchronous-observations",startedAt:this.startedAt,intervalMs:this.intervalMs,signals:[...this.signals],frames:this.frames,stopReason:reason==="error"?reason:this.capacity?"capacity":reason};}
}

export function parseTrace(text:string):TraceRecording{
 if(typeof text!=="string"||text.length>TRACE_MAX_BYTES||new TextEncoder().encode(text).length>TRACE_MAX_BYTES)throw new Error("Trace file size limit exceeded");
 const trace=JSON.parse(text) as TraceRecording;
 fields(trace,["version","source","coherence","startedAt","intervalMs","signals","frames","stopReason"]);
 if(trace.version!==1||trace.source!=="s7commplus-subscription"||trace.coherence!=="asynchronous-observations"||!timestamp(trace.startedAt)||!Number.isInteger(trace.intervalMs)||trace.intervalMs<100||trace.intervalMs>60000||!signalsValid(trace.signals)||!Array.isArray(trace.frames)||trace.frames.length>TRACE_MAX_FRAMES||!["duration","stopped","capacity","error"].includes(trace.stopReason))throw new Error("Invalid trace schema");
 let previous:TraceFrame|undefined;
 for(const frame of trace.frames){fields(frame,["elapsedMs","sourceAt","scope","state","cells"]);fields(frame.scope,["device","address","transport","epoch"]);fields(frame.cells,trace.signals);
  if(!timestamp(frame.elapsedMs)||frame.elapsedMs>3600000||(previous?.elapsedMs??0)>frame.elapsedMs||!timestamp(frame.sourceAt)||!scopeValid(frame.scope)||!states.includes(frame.state))throw new Error("Invalid trace frame");
  if(previous&&(frame.scope.device!==previous.scope.device||frame.scope.address!==previous.scope.address))throw new Error("Trace target changed");
  if(previous&&frame.scope.epoch<previous.scope.epoch)throw new Error("Obsolete trace epoch");
  for(const name of trace.signals){const cell=frame.cells[name]!;fields(cell,["value","observedAt","type","error"],["value"]);
   if(!(cell.value===null||typeof cell.value==="boolean"||finite(cell.value))||(cell.observedAt!==undefined&&!timestamp(cell.observedAt))||(cell.type!==undefined&&(typeof cell.type!=="string"||cell.type.length>256))||(cell.error!==undefined&&(typeof cell.error!=="string"||!cell.error||cell.error.length>4096))||(cell.value===null)!==!!cell.error||(cell.value!==null&&(!timestamp(cell.observedAt)||cell.observedAt>frame.sourceAt||frame.state!=="live"||(previous&&frame.sourceAt<previous.sourceAt))))throw new Error("Invalid trace cell/gap");
  }previous=frame;
 }return trace;
}
