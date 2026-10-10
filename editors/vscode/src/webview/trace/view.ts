// SPDX-License-Identifier: MIT
import {LitElement,html,svg,nothing} from "lit";
import {traceSegments,traceCursor,traceScale,type TraceModel} from "../../core/trace";
declare function acquireVsCodeApi():{postMessage(message:unknown):void};
export class RgTrace extends LitElement{
 static properties={trace:{state:true},title:{state:true},from:{state:true},to:{state:true},cursor:{state:true},selected:{state:true}};
 declare trace:TraceModel|undefined;declare title:string;declare from:number;declare to:number;declare cursor:number;declare selected:Set<string>;
 constructor(){super();this.trace=undefined;this.title="Trace";this.from=0;this.to=1;this.cursor=0;this.selected=new Set();}
 private readonly message=(event:MessageEvent)=>{const m=event.data;if(m?.kind!=="trace"||!m.trace)return;this.trace=m.trace;this.title=String(m.title??"Trace");this.from=0;this.to=this.end;this.cursor=0;this.selected=new Set(this.trace!.signals.slice(0,4));};
 private get end(){return Math.max(this.trace?.frames.at(-1)?.elapsedMs??0,1);}
 createRenderRoot(){return this;}
 connectedCallback(){super.connectedCallback();window.addEventListener("message",this.message);acquireVsCodeApi().postMessage({kind:"ready"});}
 disconnectedCallback(){window.removeEventListener("message",this.message);super.disconnectedCallback();}
 private zoom(factor:number){const span=Math.min(this.end,Math.max(this.trace!.intervalMs/2,(this.to-this.from)*factor));this.from=Math.max(0,Math.min(this.end-span,this.cursor-span/2));this.to=this.from+span;}
 private toggle(name:string){const next=new Set(this.selected);if(next.has(name))next.delete(name);else next.add(name);this.selected=next;}
 render(){const trace=this.trace;if(!trace)return html`<p>Loading trace…</p>`;const frame=traceCursor(trace,this.cursor);
  return html`<main class="rg-trace"><h1>${this.title}</h1><p>${trace.source==="s7commplus-subscription"?"Asynchronous observations":"Imported TIA long-term CSV"} · ${trace.frames.length} frames · ${trace.stopReason}. Curves hold values between observations. Errors, time gaps and reconnects break curves. Cycle timing not verified.</p>
   ${trace.source==="tia-long-term-csv"?html`<details><summary>CSV provenance</summary><p>SHA256 ${trace.sourceSha256}</p><p>${trace.header[0]} · activation ${trace.header[1]}</p><p>CSV provides no signal types or units. Values 0/1 are shown numerically; raw bits remain gaps.</p></details>`:nothing}
   <div class="rg-trace-toolbar"><button data-action="zoom-in" @click=${()=>this.zoom(.5)}>Zoom in</button><button @click=${()=>this.zoom(2)}>Zoom out</button><button data-action="reset" @click=${()=>{this.from=0;this.to=this.end;}}>Reset time range</button><span>${this.from.toFixed(3)}–${this.to.toFixed(3)} ms</span></div>
   <label>Time cursor <input aria-label="Time cursor" type="range" min=${this.from} max=${this.to} step="any" .value=${String(this.cursor)} @input=${(e:Event)=>{this.cursor=Number((e.target as HTMLInputElement).value);}}></label>
   <p>${this.cursor.toFixed(3)} ms · ${frame?("scope" in frame?`observation ${frame.elapsedMs.toFixed(3)} ms; ${frame.scope.device} at ${frame.scope.address}; epoch ${frame.scope.epoch}`:`CSV sample ${frame.sampleNumber}; ${frame.sourceTimestamp}`):"No observation at this time"}</p>
   <fieldset><legend>Signals (each uses its own scale)</legend>${trace.signals.map(name=>html`<label><input type="checkbox" .checked=${this.selected.has(name)} @change=${()=>this.toggle(name)}>${name}</label>`)}</fieldset>
   ${trace.signals.filter(name=>this.selected.has(name)).map(name=>{const segments=traceSegments(trace,name),scale=traceScale(segments.flat()),cell=frame?.cells[name];const x=(time:number)=>30+740*(time-this.from)/(this.to-this.from),y=(value:number|boolean)=>100-80*scale.position(value);
    return html`<section><h2>${name}</h2><p>${cell?.error??(cell?String(cell.value):"No observation")}${cell&&"raw" in cell?` · source value ${cell.raw}`:""}${cell?.type?` (${cell.type})`:""}${cell?.observedAt!==undefined&&trace.source==="s7commplus-subscription"?` · signal observed ${new Date(cell.observedAt).toISOString()}`:""}</p>
     <svg class="rg-trace-plot" viewBox="0 0 800 120" role="img" aria-label=${`${name} trace`}><text x="0" y="15">${scale.max}</text><text x="0" y="115">${scale.min}</text><svg x="30" y="0" width="740" height="120" viewBox="30 0 740 120">${segments.map(segment=>svg`<polyline data-segment fill="none" points=${segment.map((p,i)=>`${i?`${x(p.time)},${y(segment[i-1]!.value)} `:""}${x(p.time)},${y(p.value)}`).join(" ")} />${segment.length===1?svg`<circle data-point cx=${x(segment[0]!.time)} cy=${y(segment[0]!.value)} r="2" />`:nothing}`)}<line class="rg-trace-cursor" x1=${x(this.cursor)} x2=${x(this.cursor)} y1="0" y2="120" /></svg></svg>
     ${segments.length?nothing:html`<p>No valid scalar observations</p>`}</section>`;
   })}</main>`;
 }
}
customElements.define("rg-trace",RgTrace);
