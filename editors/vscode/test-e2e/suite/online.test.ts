// SPDX-License-Identifier: MIT
// Explicit local PLCSIM read-only acceptance in the real extension host.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rungApi, waitFor } from "./helpers";
import {traceRenderer} from "./trace-renderer";

describe("native local-fixture monitor", function () {
  this.timeout(90_000);
  it("shows actual changing PLC values and reports notification-to-label latency", async () => {
    const api = await rungApi(), name = '"Fx_Global".Count';
    let socket: WebSocket | undefined, requestId = 0;
    const pending = new Map<number, (value: any) => void>();
    async function evaluate(expression: string): Promise<any> {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Renderer did not answer")); }, 2000);
        pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result.result.value); });
        socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      });
    }
    if (process.env.RUNG_E2E_RENDERER_PORT) {
      const port = Number(process.env.RUNG_E2E_RENDERER_PORT); assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const page = pages.find(p => p.type === "page" && p.url.includes("workbench")); assert.ok(page, "VS Code workbench renderer missing");
      socket = new WebSocket(page.webSocketDebuggerUrl);
      socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)); pending.get(message.id)?.(message); pending.delete(message.id); });
      await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Renderer connection failed")), { once: true }); });
      await evaluate(`(() => { window.__rungRendered = {}; new MutationObserver(() => {
        for (const row of document.querySelectorAll('.monaco-list-row')) {
          if (!row.textContent.includes(${JSON.stringify(name)})) continue;
          const label = row.querySelector('.monaco-icon-description,.label-description');
          const value = label?.textContent.trim().split(/\\s/)[0];
          if (value && !(value in window.__rungRendered)) requestAnimationFrame(() => requestAnimationFrame(() => { window.__rungRendered[value] ??= Date.now(); }));
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true }); return true; })()`);
    }
    const latency: number[] = [];
    let measuredAt = 0;
    const changed = api.live.onDidChangeTreeData(() => {
      const frame = api.live.recorder.frames.at(-1);
      if (!frame || frame.at <= measuredAt || !Object.hasOwn(frame.values, name)) return;
      measuredAt = frame.at;
      const label = api.live.getTreeItem(name);
      assert.ok(label.description); latency.push(Date.now() - frame.at);
    });
    try {
      await vscode.commands.executeCommand("rung.live.focus");
      await api.live.add(name);
      await waitFor("actual PLC notifications in Live Values", () => api.live.seen.get(name)?.state === "live" && latency.length >= 40, 60_000, 50);
      assert.equal(api.live.seen.get(name)?.error, undefined);
      const frames = api.live.recorder.frames;
      assert.ok(new Set(frames.map(frame => frame.values[name])).size > 1, "Fixture cycle counter must change");
      const ordered = latency.sort((a, b) => a - b), p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]!;
      console.log(JSON.stringify({ notificationToLabelMs: ordered, p95, measurement: "host frame timestamp to tree-item label readiness; excludes screen painting" }));
      assert.ok(p95 <= 100, `Notification-to-label p95 ${p95} ms exceeds 100 ms`);
      if (socket) {
        const rendered = await evaluate("window.__rungRendered") as Record<string, number>;
        const samples = frames.filter(frame => rendered[String(frame.values[name])] !== undefined).map(frame => rendered[String(frame.values[name])]! - frame.at).sort((a, b) => a - b);
        console.log(JSON.stringify({ notificationToRendererMs: samples, measurement: "DOM value after two animation frames; screen pixels are not sampled" }));
        assert.ok(samples.length >= 10, "At least ten actual rendered PLC values required");
        const rendererP95 = samples[Math.ceil(samples.length * .95) - 1]!;
        console.log(JSON.stringify({ rendererP95 }));
        const warm: number[] = [];
        for (let n = 0; n < 10; n++) {
          const beforeBroker = await readFile(join(api.ws.root!, ".rung", "live-owner.json"), "utf8").catch(() => "");
          await vscode.commands.executeCommand("rung.live.clear");
          const started = Date.now(); await api.live.add(name);
          const visible = await waitFor("warm PLC value in renderer", async () => {
            const frame = api.live.recorder.frames.at(-1); if (!frame || frame.at < started) return false;
            const time = await evaluate(`window.__rungRendered[${JSON.stringify(String(frame.values[name]))}]`);
            return typeof time === "number" && time >= started ? time : false;
          }, 10_000, 20);
          warm.push(visible - started);
          const beforePid = JSON.parse(beforeBroker || "{}")?.pid, afterPid = JSON.parse(await readFile(join(api.ws.root!, ".rung", "live-owner.json"), "utf8"))?.pid;
          console.log(JSON.stringify({ warmOpen: n, elapsed: visible - started, beforeBroker: beforePid, afterBroker: afterPid }));
          assert.equal(afterPid, beforePid, "Closing a consumer must preserve its shared broker");
        }
        const orderedWarm = warm.sort((a, b) => a - b), warmP95 = orderedWarm[Math.ceil(warm.length * .95) - 1]!;
        console.log(JSON.stringify({ warmFirstRenderedMs: orderedWarm, warmP95 }));
        assert.ok(rendererP95 <= 100, `Renderer p95 ${rendererP95} ms exceeds 100 ms`);
        assert.ok(warmP95 <= 500, `Warm visible-value p95 ${warmP95} ms exceeds 500 ms`);
      }
    } finally {
      changed.dispose(); socket?.close(); await vscode.commands.executeCommand("rung.live.clear");
    }
  });
});

describe("Trace readonly acceptance",function(){
 this.timeout(90000);
 it("records native signals through the command and opens the trace panel",async()=>{
  const api=await rungApi(),out=join(api.ws.root!,"native-trace.json");
  await vscode.commands.executeCommand("rung.traceRecord",{signals:["ProveOps_DB.a","ProveOps_DB.sum"],device:"PLC_1",duration:2,interval:100,out});
  const recording=JSON.parse(await readFile(out,"utf8"));assert.equal(recording.stopReason,"duration");assert.equal(recording.coherence,"asynchronous-observations");assert.ok(recording.frames.length>=5);
  assert.ok(recording.frames.every((f:any)=>f.scope.address==="192.168.250.1"&&typeof f.cells["ProveOps_DB.a"].value==="number"&&!f.cells["ProveOps_DB.a"].error));
  assert.equal(api.trace()?.shown?.frames.length,recording.frames.length);
  const before=await readFile(out,"utf8");await vscode.commands.executeCommand("rung.traceOpen",out);assert.equal(await readFile(out,"utf8"),before);
  console.log(JSON.stringify({traceNativeFrames:recording.frames.length,source:recording.source,coherence:recording.coherence}));api.trace()?.dispose();
 });
 it("saves a valid stopped recording on progress cancellation",async()=>{
  const api=await rungApi(),out=join(api.ws.root!,"stopped-trace.json"),original=vscode.window.withProgress,source=new vscode.CancellationTokenSource();
  (vscode.window as any).withProgress=async(_options:any,run:any)=>{const timer=setTimeout(()=>source.cancel(),1200);try{return await run({report:()=>{}},source.token);}finally{clearTimeout(timer);}};
  try{await vscode.commands.executeCommand("rung.traceRecord",{signals:["ProveOps_DB.a"],device:"PLC_1",duration:30,interval:100,out});const recording=JSON.parse(await readFile(out,"utf8"));assert.equal(recording.stopReason,"stopped");assert.ok(recording.frames.length>=1);assert.equal(api.trace()?.shown?.stopReason,"stopped");console.log(JSON.stringify({stoppedTraceFrames:recording.frames.length}));}
  finally{(vscode.window as any).withProgress=original;source.dispose();api.trace()?.dispose();}
 });
 it("imports real native-format CSV offline and preserves nanoseconds in the panel",async()=>{
  const api=await rungApi(),source=vscode.Uri.file(join(process.env.RUNG_E2E_REPO!,"packages/live/test/fixtures/trace/tia-v20-long-term.csv")),out=vscode.Uri.file(join(api.ws.root!,"native-import.json"));
  const open=vscode.window.showOpenDialog,save=vscode.window.showSaveDialog;
  (vscode.window as any).showOpenDialog=async()=>[source];(vscode.window as any).showSaveDialog=async()=>out;
  try{await vscode.commands.executeCommand("rung.traceImport");const model=api.trace()?.shown;assert.equal(model?.source,"tia-long-term-csv");assert.ok(model&&"sourceSha256" in model);assert.equal(model.sourceSha256,"47a31eebbdc9b1c61bad42e21c8117f9ab69544f7db6a0c40fa2db02dc61f3b1");assert.ok("sourceTimestamp" in model.frames[3]!);assert.equal(model.frames[3]!.sourceTimestamp,"2023-11-14-22:13:20.300000369");assert.equal(model.frames[3]!.elapsedMs,300.000369);}
  finally{(vscode.window as any).showOpenDialog=open;(vscode.window as any).showSaveDialog=save;api.trace()?.dispose();}
 });
 it("renders Trace curves and exact cursor text inside the real CSP webview",async function(){
  if(!process.env.RUNG_E2E_RENDERER_PORT)this.skip();const api=await rungApi(),out=join(api.ws.root!,"render-import.json");
  const result=await api.cli.capture(["trace","import",join(process.env.RUNG_E2E_REPO!,"packages/live/test/fixtures/trace/tia-v20-long-term.csv"),"--out",out,"--json"]);assert.equal(result.code,0);await vscode.commands.executeCommand("rung.traceOpen",out);
  const renderer=await traceRenderer(Number(process.env.RUNG_E2E_RENDERER_PORT));
  try{const result=await renderer.evaluate(`(async()=>{const view=document.querySelector('rg-trace');await view.updateComplete;const count=view.querySelectorAll('polyline[data-segment]').length;const cursor=view.querySelector('[aria-label="Time cursor"]');cursor.value='300.000369';cursor.dispatchEvent(new Event('input',{bubbles:true}));await view.updateComplete;const text=view.textContent;view.querySelector('[data-action="zoom-in"]').click();await view.updateComplete;return {count,text,zoomed:view.to-view.from};})()`);assert.ok(result.count>=6);assert.ok(result.text.includes("2023-11-14-22:13:20.300000369"));assert.ok(result.text.includes("Imported TIA long-term CSV"));assert.ok(result.zoomed<300.000369);console.log(JSON.stringify({actualTracePolylines:result.count,exactCursor:true,zoomedMs:result.zoomed}));}
  finally{renderer.close();api.trace()?.dispose();}
 });
});
