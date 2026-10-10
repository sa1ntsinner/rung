// SPDX-License-Identifier: MIT
import {expect,it,vi} from "vitest";
vi.mock("vscode",()=>({window:{createWebviewPanel:vi.fn()},ViewColumn:{Beside:2},Uri:{joinPath:(_base:unknown,...parts:string[])=>parts.join("/")}}));
import * as vscode from "vscode";
import {TracePanel} from "../src/trace/panel";
import type {TraceModel} from "../src/core/trace";
it("reuses one nonce/CSP panel, delivers data after ready and releases it on close",()=>{
 let receive!:(m:unknown)=>void,closed!:()=>void;const disposable=()=>({dispose:vi.fn()});
 const webview={html:"",cspSource:"safe",asWebviewUri:(p:string)=>({toString:()=>p}),postMessage:vi.fn(),onDidReceiveMessage:(fn:typeof receive)=>{receive=fn;return disposable();}};
 const panel={webview,title:"",reveal:vi.fn(),dispose:vi.fn(),onDidDispose:(fn:()=>void)=>{closed=fn;return disposable();}};
 vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panel as unknown as vscode.WebviewPanel);
 const ctx={extensionUri:{},subscriptions:[]} as unknown as vscode.ExtensionContext,model={source:"s7commplus-subscription"} as TraceModel;
 const view=TracePanel.show(ctx,model,"one");expect(webview.html).toContain("Content-Security-Policy");expect(webview.html).toContain("trace.js");receive({kind:"ready"});expect(webview.postMessage).toHaveBeenCalledWith({kind:"trace",trace:model,title:"one"});
 expect(TracePanel.show(ctx,model,"two")).toBe(view);expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);closed();expect(view.shown).toBeUndefined();expect(TracePanel.open).toBeUndefined();view.dispose();expect(panel.dispose).toHaveBeenCalledTimes(1);
});
