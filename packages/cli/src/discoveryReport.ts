// SPDX-License-Identifier: BUSL-1.1
import type { DiscoveryEvidence } from "./discover.js";
import { randomBytes } from "node:crypto";

/**
 * The evidence as one self-contained page: in VS Code it takes the editor's theme like rung's other views,
 * in a browser a plain light or dark one. All project-controlled text is data, never HTML.
 */
export function discoveryHtml(evidence: DiscoveryEvidence): string {
  const json = JSON.stringify(evidence).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const nonce = randomBytes(24).toString("base64");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Behaviour Discovery</title><style nonce="${nonce}">
:root{--fb-bg:#ffffff;--fb-fg:#1f1f1f;--fb-muted:#616161;--fb-line:#e5e5e5;--fb-panel:#f8f8f8;--fb-before:#1a85ff;--fb-now:#c4560d;--fb-warn:#bf8803;--fb-del:#ffd7d5;--fb-ins:#d4f3d6;--fb-btn:#005fb8;--fb-btn-fg:#ffffff;--fb-focus:#005fb8}
@media (prefers-color-scheme:dark){:root{--fb-bg:#1f1f1f;--fb-fg:#cccccc;--fb-muted:#9d9d9d;--fb-line:#2b2b2b;--fb-panel:#181818;--fb-before:#4daafc;--fb-now:#f09c4f;--fb-warn:#cca700;--fb-del:#5a1d1d;--fb-ins:#1e3b22;--fb-btn:#0078d4;--fb-btn-fg:#ffffff;--fb-focus:#0078d4}}
:root{--bg:var(--vscode-editor-background,var(--fb-bg));--fg:var(--vscode-editor-foreground,var(--fb-fg));--muted:var(--vscode-descriptionForeground,var(--fb-muted));--line:var(--vscode-editorGroup-border,var(--vscode-panel-border,var(--fb-line)));--panel:var(--vscode-editorWidget-background,var(--fb-panel));--before:var(--vscode-charts-blue,var(--fb-before));--now:var(--vscode-charts-orange,var(--fb-now));--warn:var(--vscode-editorWarning-foreground,var(--fb-warn));--del:var(--vscode-diffEditor-removedLineBackground,var(--fb-del));--ins:var(--vscode-diffEditor-insertedLineBackground,var(--fb-ins));--btn:var(--vscode-button-background,var(--fb-btn));--btn-fg:var(--vscode-button-foreground,var(--fb-btn-fg));--btn2:var(--vscode-button-secondaryBackground,transparent);--btn2-fg:var(--vscode-button-secondaryForeground,var(--fg));--focus:var(--vscode-focusBorder,var(--fb-focus));--ui:var(--vscode-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);--code:var(--vscode-editor-font-family,ui-monospace,"Cascadia Mono",Consolas,monospace);--code-size:var(--vscode-editor-font-size,13px)}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--ui)}
main{max-width:1100px;margin:0 auto;padding:16px 16px 40px}
header{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding-bottom:12px;border-bottom:1px solid var(--line)}
h1{margin:0;font:600 calc(var(--code-size) + 3px)/1.3 var(--code)}
.tag{font-size:11px;line-height:16px;padding:0 6px;border:1px solid var(--line);border-radius:2px;color:var(--muted)}
.tag.found{border-color:var(--warn);color:var(--warn)}
.crumbs{color:var(--muted);font-size:12px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actions{display:flex;gap:8px}
button{font:inherit;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;padding:4px 12px;cursor:pointer;background:var(--btn);color:var(--btn-fg)}
button.secondary{background:var(--btn2);color:var(--btn2-fg);border-color:var(--vscode-button-border,var(--line))}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,select:focus-visible,svg:focus-visible,summary:focus-visible{outline:1px solid var(--focus);outline-offset:2px}
h2{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:24px 0 8px}
.story{font-size:15px;line-height:1.55;margin:16px 0 0;max-width:80ch}
.story b{font-family:var(--code);font-weight:600}.v-before{color:var(--before)}.v-now{color:var(--now)}
.cause{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.cause>div{border:1px solid var(--line);border-radius:2px;padding:10px 12px;min-width:0;background:var(--panel)}
.cause .who{font-size:12px;color:var(--muted)}.cause .who i{font-style:normal;display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0}
.cause code{display:block;font:var(--code-size)/1.5 var(--code);white-space:pre;overflow:auto;margin:6px 0 4px}
.cause .wrote{font:var(--code-size) var(--code)}
.wave-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
select{font:inherit;background:var(--vscode-dropdown-background,var(--bg));color:var(--vscode-dropdown-foreground,var(--fg));border:1px solid var(--vscode-dropdown-border,var(--line));border-radius:2px;padding:2px 6px}
.readout{font:var(--code-size) var(--code);color:var(--muted)}
.wave{display:grid;grid-template-columns:max-content minmax(0,1fr);column-gap:12px;margin-top:8px;border:1px solid var(--line);border-radius:2px;padding:8px 12px 4px}
.lanes div{height:28px;line-height:28px;font:12px/28px var(--code);white-space:nowrap;text-align:right}
.lanes .sep{height:8px}
svg{display:block;width:100%;overflow:visible;cursor:pointer}
.src{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.src>div{min-width:0}.src .file{font-size:12px;color:var(--muted);margin-bottom:4px}
pre{position:relative;margin:0;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:2px;font:var(--code-size)/1.5 var(--code);background:var(--vscode-textCodeBlock-background,var(--panel))}
pre span{display:block;padding:0 8px 0 0;white-space:pre}pre span::before{content:attr(data-n);display:inline-block;width:4ch;margin-right:12px;text-align:right;color:var(--muted)}
pre .del{background:var(--del)}pre .ins{background:var(--ins)}pre .hit{box-shadow:inset 3px 0 var(--warn)}
details{margin-top:24px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;color:var(--muted)}
details ul{margin:8px 0;padding-left:18px;color:var(--muted);max-width:90ch}
table{border-collapse:collapse;font:12px var(--code);margin-top:8px}th,td{padding:2px 10px 2px 0;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:400}
tr.diff td{color:var(--warn)}tr.sel td{text-decoration:underline}
.notice{margin:12px 0 0;color:var(--muted);font-size:12px}.notice b{font-weight:400;color:var(--warn)}
.empty{color:var(--muted);margin-top:16px;max-width:80ch}
nav.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-top:16px;border-bottom:1px solid var(--line)}
nav.tabs button{background:transparent;color:var(--muted);border:0;border-bottom:2px solid transparent;border-radius:0;padding:4px 10px;font-family:var(--code)}
nav.tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--focus)}
.trail{margin:6px 0 0;padding:0;list-style:none;font:12px/1.6 var(--code)}
.trail li{display:flex;gap:8px;min-width:0}.trail .n{color:var(--muted);min-width:4ch;text-align:right}
.trail .t{white-space:pre;overflow:hidden;text-overflow:ellipsis;min-width:0}.trail .r{color:var(--muted);margin-left:auto;white-space:nowrap}
.trail .r b,.trail.r b{font-weight:400;color:var(--fg)}div.trail.r{margin-top:2px}.trail b.diff{color:var(--warn);font-weight:600}.trail .r b.diff{color:var(--warn);font-weight:600}
pre .why{box-shadow:inset 3px 0 var(--line)}
@media(max-width:640px){.cause,.src{grid-template-columns:1fr}.actions{width:100%}}
</style></head><body><main>
<header><h1 id="block"></h1><span class="tag" id="status"></span><span class="crumbs" id="crumbs"></span>
<span class="actions"><button id="save-test">Save as test…</button><button id="save-evidence" class="secondary">Save evidence</button></span></header>
<p class="notice" id="also" hidden></p>
<nav class="tabs" id="tabs" role="tablist" aria-label="Findings" hidden></nav>
<p class="story" id="story"></p>
<section id="found">
<h2>What wrote it, and why it ran</h2><div class="cause" id="cause"></div>
<h2>Timeline</h2>
<div class="wave-head"><label for="signal">Signal</label><select id="signal"></select><span class="readout" id="readout"></span></div>
<div class="wave"><div class="lanes" id="lanes"></div><svg id="chart" tabindex="0" role="img" aria-label="Inputs and the selected signal, before your change and now, scan by scan"></svg></div>
<details><summary>Scan by scan</summary><table id="scans"></table></details>
<h2>Source</h2><div class="src"><div><div class="file" id="before-file"></div><pre id="before-source"></pre></div><div><div class="file" id="after-file"></div><pre id="after-source"></pre></div></div>
</section>
<details><summary>What this shows, and what it does not</summary><ul id="assumptions"></ul><pre id="metadata"></pre></details>
</main><script id="evidence" type="application/json">${json}</script><script nonce="${nonce}">
const e=JSON.parse(document.getElementById('evidence').textContent),$=id=>document.getElementById(id),all=e.findings||(e.witness?[e.witness]:[]);
const show=v=>typeof v==='boolean'?(v?'TRUE':'FALSE'):String(v),same=(a,b)=>typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b)):a===b;
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n};
const commit=e.reference.commit.slice(0,8),cycleMs=parseFloat(e.config.cycle)*(/ms$/i.test(e.config.cycle)?1:/s$/i.test(e.config.cycle)?1000:1);
const duration=n=>{const ms=Math.round(n*cycleMs);return ms<1000?ms+' ms':(ms/1000).toFixed(2).replace(/[.]?0+$/,'')+' s'};
$('block').textContent=e.config.block;
$('status').textContent=all.length>1?all.length+' differences':all.length?'difference':'no difference';if(all.length)$('status').classList.add('found');
$('crumbs').textContent=(e.sources?e.sources.after.file+' · ':'')+'against '+commit;
if(e.alsoChanged&&e.alsoChanged.length){$('also').hidden=false;$('also').append('Also changed since '+commit+', and may cause what you see here: ',el('b','',e.alsoChanged.map(f=>f.replace(/^.*[/]/,'')).join(', ')))}
for(const a of e.assumptions)$('assumptions').append(el('li','',a));
$('metadata').textContent=JSON.stringify({reference:e.reference,current:e.current,inputs:e.config.inputs,fixed:e.config.fixed,outputs:e.config.outputs,cycle:e.config.cycle,search:{seed:e.config.seed,maxCycles:e.config.maxCycles,maxEvents:e.config.maxEvents,maxRuns:e.config.maxRuns,holds:e.config.holds,timeoutMs:e.config.timeoutMs},replayed:e.runs,reused:e.reused,stopped:e.stopped,reduced:e.reduced,reductionNotes:e.reductionNotes},null,2);
const api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():undefined;
function save(name,content,type){if(api){api.postMessage({command:name==='reference.test.yaml'?'save-reference':'save-evidence'});return}const u=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
$('save-test').disabled=!all.length;$('save-test').textContent=all.length>1?'Save as tests…':'Save as test…';
$('save-test').onclick=()=>save('reference.test.yaml',e.referenceTest,'text/yaml');$('save-evidence').onclick=()=>save('evidence.json',JSON.stringify(e,null,2),'application/json');
const lines={before:e.sources?e.sources.before.text.split(String.fromCharCode(10)):[],after:e.sources?e.sources.after.text.split(String.fromCharCode(10)):[]};
// an input with one value never changes: it is neither told nor drawn
const names=Object.keys(e.config.inputs).filter(n=>e.config.inputs[n].length>1);
const ns='http://www.w3.org/2000/svg',lane=28;
function svg(parent,tag,attrs,text){const n=document.createElementNS(ns,tag);for(const k in attrs)n.setAttribute(k,String(attrs[k]));if(text!==undefined)n.textContent=text;parent.append(n);return n}
let w,inputs,frames,selected=0,current=-1;
if(!all.length){
 $('found').hidden=true;
 $('story').textContent='No input sequence in this search made an output differ: '+e.runs+' scenarios of up to '+e.config.maxCycles+' scans ran on both versions'+(e.stopped==='time-budget'?', until the search time ran out':'')+'. That does not prove the two versions behave the same.';
}else{
 for(const n of e.config.outputs){const o=el('option','',n);o.value=n;$('signal').append(o)}
 if(all.length>1){$('tabs').hidden=false;all.forEach((f,k)=>{const b=el('button','',(k+1)+' · '+f.difference.signal+' '+show(f.difference.before)+' → '+show(f.difference.after));b.setAttribute('role','tab');b.onclick=()=>render(k);$('tabs').append(b)})}
 $('chart').onclick=ev=>{const r=$('chart').getBoundingClientRect();selected=Math.min(frames-1,Math.max(0,Math.floor((ev.clientX-r.left)/Math.max(1,r.width)*frames)));draw()};
 $('chart').onkeydown=ev=>{if(ev.key==='ArrowRight'||ev.key==='ArrowLeft'){selected=Math.min(frames-1,Math.max(0,selected+(ev.key==='ArrowRight'?1:-1)));draw();ev.preventDefault()}};
 $('signal').onchange=draw;
 if(typeof ResizeObserver==='function'){let last=0;new ResizeObserver(()=>{const width=$('chart').clientWidth;if(width&&width!==last){last=width;draw()}}).observe($('chart'))}
 render(0);
}
function render(k){
 current=k;w=all[k];inputs=w.steps.flatMap(s=>Array.from({length:s.cycles},()=>s.set));frames=w.before.length;const d=w.difference;
 [...$('tabs').children].forEach((b,n)=>b.setAttribute('aria-selected',String(n===k)));
 // the story: what the inputs did, then what the signal did
 const story=$('story'),part=(t,cls)=>{if(cls){const b=el('b',cls,t);story.append(b)}else story.append(t)},rest=(n,v)=>same(v,e.config.inputs[n][0]),bools=names.every(n=>typeof e.config.inputs[n][0]==='boolean'),atRest=bools?'FALSE':'at their start values';
 story.replaceChildren();
 let previous;w.steps.forEach((s,i)=>{const shown=names.filter(n=>previous?!same(previous[n],s.set[n]):!rest(n,s.set[n]));
  part(i?', then ':'');if(!shown.length)part(i?'nothing changes':'All inputs '+atRest);
  shown.forEach((n,k)=>{part((k?', ':'')+n+' = ');part(show(s.set[n]),'v')});if(!i&&shown.length&&shown.length<names.length)part(', all other inputs '+atRest);part(' for '+s.cycles+(s.cycles===1?' scan':' scans')+(s.cycles>2?' ('+duration(s.cycles)+')':''));previous=s.set});
 part('. At scan '+d.cycle+(d.cycle>2?' ('+duration(d.cycle)+')':'')+', ');part(d.signal,'v');part(' is ');part(show(d.before),'v-before');part(' before your change and ');part(show(d.after),'v-now');part(' now.');
 // what wrote the value in each revision, inside which IFs, and what they read; a read that differs between the two is marked
 const cause=w.cause||{},value=(side,name)=>{for(const c of(cause[side]&&cause[side].because)||[])for(const r of c.reads)if(r.name===name)return r.value};
 $('cause').replaceChildren();
 for(const [side,label,color] of [['before','Before your change · '+commit,'--before'],['after','Now · working tree','--now']]){
  const other=side==='before'?'after':'before',box=el('div'),who=el('div','who'),dot=el('i');dot.style.background='var('+color+')';who.append(dot,label);box.append(who);
  const c=cause[side];
  if(c){
   // the write's own reads go with it; the trail is the statements it ran inside
   const steps=c.because||[],own=steps.length&&steps[steps.length-1].line===c.line?steps[steps.length-1]:undefined,around=own?steps.slice(0,-1):steps;
   const reads=(list,into)=>list.forEach((x,n)=>{const o=value(other,x.name);into.append((n?' · ':'')+x.name+' = ',el('b',o!==undefined&&!same(o,x.value)?'diff':'',show(x.value)))});
   const wrote=el('div','wrote',e.sources[side].file.replace(/^.*[/]/,'')+':'+c.line+' wrote '+show(c.value)+' at scan '+c.scan);
   box.append(el('code','',(lines[side][c.line-1]||'').trim()),wrote);
   if(own&&own.reads.length){const r=el('div','trail r');r.append('reading ');reads(own.reads,r);box.append(r)}
   if(around.length){const list=el('ul','trail');for(const step of around){const li=el('li');li.append(el('span','n',String(step.line)),el('span','t',(lines[side][step.line-1]||'').trim()));
    if(step.reads.length){const r=el('span','r');reads(step.reads,r);li.append(r)}
    list.append(li)}box.append(list)}
   // a call that read the same on both sides answered differently: what changed is inside what it calls
   const o=cause[other],text=s=>(lines[s][cause[s].line-1]||'').trim(),flat=x=>JSON.stringify((x.because||[]).map(s=>s.reads));
   if(side==='after'&&o&&text('before')===text('after')&&/^(#|")[^(:=]*[(]/.test(text('after'))&&flat(o)===flat(c)&&!same(o.value,c.value))box.append(el('p','notice','Both versions read the same values here: the difference comes from inside what line '+c.line+' calls.'));
  }else box.append(el('div','wrote','No write to '+d.signal+' up to scan '+d.cycle+': it kept its start value.'));
  $('cause').append(box)}
 $('signal').value=d.signal;selected=d.cycle-1;draw();
 // source: the changed lines of each side, the written line and the statements around it marked
 for(const side of['before','after']){
  if(!e.sources)break;$(side+'-file').textContent=(side==='before'?commit+' · ':'working tree · ')+e.sources[side].file;
  const changed=new Set((e.changedLines||{})[side]||[]),c=cause[side],hit=c?c.line:0,why=new Set(c&&c.because?c.because.map(b=>b.line):[]),pre=$(side+'-source');
  pre.replaceChildren();
  lines[side].forEach((l,i)=>{const s=el('span',(changed.has(i+1)?(side==='before'?'del':'ins'):'')+(hit===i+1?' hit':why.has(i+1)?' why':''),l);s.dataset.n=String(i+1);pre.append(s)});
  const mark=pre.querySelector('.hit');if(mark)pre.scrollTop=Math.max(0,pre.scrollTop+mark.getBoundingClientRect().top-pre.getBoundingClientRect().top-pre.clientHeight/3)}
}
function draw(){
 if(!w)return;
 const signal=$('signal').value,rows=[...names.map(n=>({name:n,values:inputs.map(s=>s[n]),color:'var(--fg)'})),null,{name:signal+' before',values:w.before.map(f=>f[signal]),color:'var(--before)'},{name:signal+' now',values:w.after.map(f=>f[signal]),color:'var(--now)'}];
 const chart=$('chart'),W=Math.max(200,chart.clientWidth||1000),height=rows.reduce((h,r)=>h+(r?lane:8),0)+18,x=i=>i/frames*W;
 chart.setAttribute('viewBox','0 0 '+W+' '+height);chart.style.height=height+'px';chart.replaceChildren();$('lanes').replaceChildren();
 for(let i=0;i<frames;i++)if(!same(w.before[i][signal],w.after[i][signal]))svg(chart,'rect',{x:x(i),y:0,width:W/frames,height:height-18,fill:'var(--warn)','fill-opacity':.14});
 svg(chart,'rect',{x:x(selected),y:0,width:W/frames,height:height-18,fill:'none',stroke:'var(--focus)','stroke-width':1});
 let y=0;for(const r of rows){
  if(!r){$('lanes').append(el('div','sep'));y+=8;continue}
  const label=el('div','',r.name);label.style.color=r.color;$('lanes').append(label);
  if(r.values.every(v=>typeof v==='boolean')){r.values.forEach((v,i)=>{if(v)svg(chart,'rect',{x:x(i),y:y+6,width:x(i+1)-x(i),height:lane-12,fill:r.color,'fill-opacity':.14})});let p='';r.values.forEach((v,i)=>{const yy=y+(v?6:lane-6);p+=(i?' L'+x(i)+' '+yy:'M0 '+yy)+' L'+x(i+1)+' '+yy});svg(chart,'path',{d:p,fill:'none',stroke:r.color,'stroke-width':1.5})}
  else{let start=0;for(let i=1;i<=frames;i++)if(i===frames||!same(r.values[i],r.values[start])){const width=x(i)-x(start);svg(chart,'rect',{x:x(start)+1,y:y+5,width:Math.max(1,width-2),height:lane-10,fill:'none',stroke:r.color,'stroke-width':1});const text=show(r.values[start]);if(text.length*7+8<width)svg(chart,'text',{x:x(start)+width/2,y:y+lane/2+4,'text-anchor':'middle','font-size':11,'font-family':'var(--code)',fill:r.color},text);start=i}}
  y+=lane}
 for(let i=0;i<frames;i+=Math.max(1,Math.ceil(frames/10)))svg(chart,'text',{x:x(i)+2,y:height-4,'font-size':11,fill:'var(--muted)'},String(i+1));
 const f=selected;$('readout').textContent='scan '+(f+1)+' · '+duration(f+1)+' · '+names.map(n=>n+'='+show(inputs[f][n])).join(' ')+' · before '+show(w.before[f][signal])+', now '+show(w.after[f][signal]);
 const t=$('scans');t.replaceChildren();const head=el('tr');for(const h of['scan',...names,signal+' before',signal+' now'])head.append(el('th','',h));t.append(head);
 for(let i=0;i<frames;i++){const tr=el('tr',(!same(w.before[i][signal],w.after[i][signal])?'diff':'')+(i===selected?' sel':''));for(const v of[i+1,...names.map(n=>show(inputs[i][n])),show(w.before[i][signal]),show(w.after[i][signal])])tr.append(el('td','',String(v)));tr.onclick=()=>{selected=i;draw()};t.append(tr)}
}
</script></body></html>`;
}
