// SPDX-License-Identifier: BUSL-1.1
import {TRACE_MAX_BYTES,TRACE_MAX_FRAMES,type TraceCell} from "./trace.js";
import {createHash} from "node:crypto";
export interface TraceCsvCell extends TraceCell{raw:string;}
export interface TraceCsvFrame{elapsedMs:number;sourceAt:number;sourceTimestamp:string;sampleNumber:string;state:"recorded";cells:Record<string,TraceCsvCell>;}
export interface TraceCsvView{version:1;source:"tia-long-term-csv";coherence:"imported-file";sourceSha256:string;header:string[];startedAt:number;intervalMs:number;signals:string[];frames:TraceCsvFrame[];stopReason:"imported";}
export interface TraceCsvFile{version:1;source:"tia-long-term-csv";sourceSha256:string;csv:string;}
const UINT64_MAX=18446744073709551615n;
function bounded(text:string){if(typeof text!=="string"||text.length>TRACE_MAX_BYTES||new TextEncoder().encode(text).length>TRACE_MAX_BYTES)throw new Error("Trace CSV size limit exceeded");}
function ns(text:string):bigint{
 const m=/^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2}):(\d{2})\.(\d{9})$/.exec(text);if(!m)throw new Error("Unsupported CSV timestamp; expected LDT with nine fractional digits");
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number) as [number,number,number,number,number,number];
 const date=new Date(Date.UTC(year,month-1,day,hour,minute,second));date.setUTCFullYear(year);
 if(year<1970||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==second)throw new Error("Invalid CSV date/time");
 const value=BigInt(date.getTime())*1000000n+BigInt(m[7]!);if(value>UINT64_MAX)throw new Error("CSV timestamp exceeds native UInt64 range");return value;
}
const ms=(value:bigint)=>Number(value/1000000n)+Number(value%1000000n)/1000000;
function scalar(raw:string,at:number):TraceCsvCell{
 if(raw.length>128)throw new Error("CSV scalar size limit exceeded");
 if(/^16#[\dA-F]{2}(?:_?[\dA-F]{2}){0,7}$/i.test(raw))return{value:null,raw,error:"Raw bits require signal type metadata"};
 if(!/^[+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(raw))throw new Error("Unsupported CSV scalar format; numeric decimal-point profile required");
 const value=Number(raw),integer=Number.isInteger(value),underflow=value===0&&/[1-9]/.test(raw.split(/[Ee]/)[0]!);
 if(!Number.isFinite(value)||(integer&&!Number.isSafeInteger(value))||underflow)return{value:null,raw,error:"Unsupported numeric range/precision"};
 return{value,raw,observedAt:at};
}
export function parseTraceCsv(csv:string):TraceCsvView{
 bounded(csv);const sourceSha256=createHash("sha256").update(csv,"utf8").digest("hex");
 let pos=csv.charCodeAt(0)===65279?1:0;
 const line=(limit:number)=>{const end=csv.indexOf("\n",pos),until=end<0?csv.length:end;if(until-pos>limit)throw new Error("CSV line size limit exceeded");const text=csv.slice(pos,until).replace(/\r$/,"" );pos=end<0?csv.length:end+1;if(/[\x00-\x1f\x7f]/.test(text))throw new Error("Unsupported CSV control character");return text;};
 const header=line(65536).split(";",35),activation=header[1];
 if(header.length<3||header.length>34||!header[0]||header[0].length>1024||!activation||!/^\d{8}_\d{6}_\d{3}$/.test(activation))throw new Error("Unsupported TIA CSV header profile");
 ns(`${activation.slice(0,4)}-${activation.slice(4,6)}-${activation.slice(6,8)}-${activation.slice(9,11)}:${activation.slice(11,13)}:${activation.slice(13,15)}.${activation.slice(16)}000000`);
 const signals=header.slice(2);if(signals.some(s=>!s.trim()||s.length>1024)||new Set(signals.map(s=>s.toLowerCase())).size!==signals.length)throw new Error("Invalid/duplicate CSV signals");
 const frames:TraceCsvFrame[]=[];let first:bigint|undefined,previousTime:bigint|undefined,previousSample:bigint|undefined,bytes=65536;
 while(pos<csv.length){if(frames.length>=TRACE_MAX_FRAMES)throw new Error("CSV row limit exceeded");const row=line(8192).split(";",35);
  if(row.length!==header.length||! /^(0|[1-9]\d{0,19})$/.test(row[0]!))throw new Error("Invalid CSV row/sample number");
  const sample=BigInt(row[0]!),time=ns(row[1]!);if(sample>UINT64_MAX||(previousSample!==undefined&&sample<=previousSample)||(previousTime!==undefined&&time<=previousTime))throw new Error("CSV samples/timestamps must increase");
  first??=time;const elapsed=time-first;if(elapsed>3600000000000n)throw new Error("CSV measurement exceeds one-hour limit");const at=ms(time);
  const frame:TraceCsvFrame={elapsedMs:Number(elapsed)/1000000,sourceAt:at,sourceTimestamp:row[1]!,sampleNumber:row[0]!,state:"recorded",cells:Object.fromEntries(signals.map((name,i)=>[name,scalar(row[i+2]!,at)]))};
  bytes+=new TextEncoder().encode(JSON.stringify(frame)).length+1;if(bytes>TRACE_MAX_BYTES)throw new Error("Normalized CSV trace size limit exceeded");frames.push(frame);previousTime=time;previousSample=sample;
 }
 if(!frames.length)throw new Error("CSV has no measurement rows");
 return{version:1,source:"tia-long-term-csv",coherence:"imported-file",sourceSha256,header,startedAt:frames[0]!.sourceAt,intervalMs:frames[1]?.elapsedMs??1,signals,frames,stopReason:"imported"};
}
export function parseTraceCsvFile(text:string):TraceCsvView{
 bounded(text);const file=JSON.parse(text) as TraceCsvFile;
 if(!file||typeof file!=="object"||Array.isArray(file)||Object.keys(file).length!==4||Object.keys(file).some(k=>!["version","source","sourceSha256","csv"].includes(k))||file.version!==1||file.source!=="tia-long-term-csv"||typeof file.csv!=="string")throw new Error("Invalid native CSV trace file");
 const view=parseTraceCsv(file.csv);if(typeof file.sourceSha256!=="string"||view.sourceSha256!==file.sourceSha256.toLowerCase())throw new Error("CSV source SHA256 mismatch");return view;
}
