// SPDX-License-Identifier: MIT
// Portable model mirrors the CLI recorder; the compatibility test pins its shape.
export interface TraceCell{value:number|boolean|null;observedAt?:number;type?:string;error?:string;}
export interface TraceFrame{elapsedMs:number;sourceAt:number;scope:{device:string;address:string;transport:"s7commplus"|"webapi";epoch:number};state:"connecting"|"live"|"stale"|"disconnected";cells:Record<string,TraceCell>;}
export interface SubscriptionTraceModel{version:1;source:"s7commplus-subscription";coherence:"asynchronous-observations";startedAt:number;intervalMs:number;signals:string[];frames:TraceFrame[];stopReason:"duration"|"stopped"|"capacity"|"error";}
export interface TraceCsvCell extends TraceCell{raw:string;}
export interface TraceCsvFrame{elapsedMs:number;sourceAt:number;sourceTimestamp:string;sampleNumber:string;state:"recorded";cells:Record<string,TraceCsvCell>;}
export interface TraceCsvModel{version:1;source:"tia-long-term-csv";coherence:"imported-file";sourceSha256:string;header:string[];startedAt:number;intervalMs:number;signals:string[];frames:TraceCsvFrame[];stopReason:"imported";}
export type TraceModel=SubscriptionTraceModel|TraceCsvModel;
export interface TracePoint{time:number;value:number|boolean;}
export function traceSegments(trace:TraceModel,name:string):TracePoint[][]{
 const segments:TracePoint[][]=[];let current:TracePoint[]|undefined,previous:TraceFrame|TraceCsvFrame|undefined;
 for(const frame of trace.frames){const cell=frame.cells[name];
  if(previous&&(("scope" in frame&&"scope" in previous&&frame.scope.epoch!==previous.scope.epoch)||("sampleNumber" in frame&&"sampleNumber" in previous&&BigInt(frame.sampleNumber)!==BigInt(previous.sampleNumber)+1n)||frame.elapsedMs-previous.elapsedMs>trace.intervalMs*2||cell?.type!==previous.cells[name]?.type))current=undefined;
  if((frame.state!=="live"&&frame.state!=="recorded")||!cell||cell.value===null||cell.error){current=undefined;}
  else{if(!current){current=[];segments.push(current);}current.push({time:frame.elapsedMs,value:cell.value});}
  previous=frame;
 }return segments;
}
export function traceCursor(trace:TraceModel,time:number):TraceFrame|TraceCsvFrame|undefined{
 if(!Number.isFinite(time))return;
 let lo=0,hi=trace.frames.length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(trace.frames[mid]!.elapsedMs<=time)lo=mid+1;else hi=mid;}
 const frame=trace.frames[lo-1];return frame&&time-frame.elapsedMs<=trace.intervalMs*2?frame:undefined;
}
export function traceScale(points:TracePoint[]):{min:number;max:number;position(value:number|boolean):number}{
 let min=Infinity,max=-Infinity;const bool=points.length>0&&points.every(p=>typeof p.value==="boolean");
 for(const point of points){const n=Number(point.value);min=Math.min(min,n);max=Math.max(max,n);}
 if(bool){min=0;max=1;}else if(!points.length){min=0;max=1;}
 return{min,max,position(value){const n=Number(value);return min===max?0.5:Number.isFinite(max-min)?(n-min)/(max-min):(n/2-min/2)/(max/2-min/2);}};
}
