// SPDX-License-Identifier: MIT
// @vitest-environment happy-dom
import {expect,it,vi} from "vitest";
import type {TraceModel} from "../../src/core/trace";
import {parseTraceCsv} from "@rung/live";
it("renders safe labels, independent curves, gaps, zoom and actual cursor values",async()=>{
 vi.stubGlobal("acquireVsCodeApi",()=>({postMessage:vi.fn()}));
 const {RgTrace}=await import("../../src/webview/trace/view");const view=new RgTrace();document.body.append(view);
 const trace:TraceModel={version:1,source:"s7commplus-subscription",coherence:"asynchronous-observations",startedAt:0,intervalMs:100,signals:["<img src=x onerror=alert(1)>","B"],stopReason:"stopped",frames:[0,100,200,300].map((elapsedMs,i)=>({elapsedMs,sourceAt:1000+elapsedMs,scope:{device:"P",address:"local",transport:"s7commplus",epoch:1},state:"live",cells:{"<img src=x onerror=alert(1)>":i===1?{value:null,error:"Denied"}:{value:i,observedAt:1000+elapsedMs},B:{value:i%2===0,observedAt:1000+elapsedMs}}}))};
 window.dispatchEvent(new MessageEvent("message",{data:{kind:"trace",trace,title:"capture.json"}}));await view.updateComplete;
 expect(view.querySelector("img")).toBeNull();expect(view.textContent).toContain("<img src=x onerror=alert(1)>");expect(view.querySelectorAll(".rg-trace-plot")).toHaveLength(2);expect(view.querySelectorAll("[data-segment]")).toHaveLength(3);expect(view.querySelectorAll("circle[data-point]")).toHaveLength(1);
 const cursor=view.querySelector<HTMLInputElement>("[aria-label='Time cursor']")!;cursor.value="100";cursor.dispatchEvent(new Event("input"));await view.updateComplete;expect(view.textContent).toContain("Denied");
 view.querySelector<HTMLButtonElement>("[data-action='zoom-in']")!.click();await view.updateComplete;expect(Number(cursor.max)).toBeLessThan(300);
 view.querySelector<HTMLButtonElement>("[data-action='reset']")!.click();await view.updateComplete;expect(Number(cursor.max)).toBe(300);
 view.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();await view.updateComplete;expect(view.querySelectorAll(".rg-trace-plot")).toHaveLength(1);view.remove();vi.unstubAllGlobals();
});
it("shows imported CSV timestamp precision and provenance without subscription claims",async()=>{vi.stubGlobal("acquireVsCodeApi",()=>({postMessage:vi.fn()}));const {RgTrace}=await import("../../src/webview/trace/view");const view=new RgTrace();document.body.append(view);const trace=parseTraceCsv("Native;20261009_120000_000;A\n0;2023-11-14-22:13:20.000000123;1\n");window.dispatchEvent(new MessageEvent("message",{data:{kind:"trace",trace,title:"native.json"}}));await view.updateComplete;expect(view.textContent).toContain("2023-11-14-22:13:20.000000123");expect(view.textContent).toContain(trace.sourceSha256);expect(view.textContent).not.toContain("Asynchronous observations");view.remove();vi.unstubAllGlobals();});

