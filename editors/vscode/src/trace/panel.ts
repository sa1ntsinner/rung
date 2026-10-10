// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import type {TraceModel} from "../core/trace";
import {nonce,webviewHtml} from "../host/webviewHtml";

export class TracePanel implements vscode.Disposable{
 private static current:TracePanel|undefined;
 static get open():TracePanel|undefined{return this.current;}
 private readonly subs:vscode.Disposable[]=[];
 private constructor(ctx:vscode.ExtensionContext,private readonly panel:vscode.WebviewPanel,private model:TraceModel|undefined,private title:string){
  const asset=(file:string)=>panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri,"out","webview",file)).toString();
  this.subs.push(panel.webview.onDidReceiveMessage(m=>{if(m?.kind==="ready")this.post();}),panel.onDidDispose(()=>this.dispose()));
  panel.webview.html=webviewHtml({cspSource:panel.webview.cspSource,nonce:nonce(),script:asset("trace.js"),styles:[asset("codicon.css"),asset("tokens.css"),asset("rung.css")],title:"Trace"});
 }
 static show(ctx:vscode.ExtensionContext,model:TraceModel,title:string):TracePanel{
  if(this.current){this.current.model=model;this.current.title=title;this.current.panel.title=`${title} · Trace`;this.current.panel.reveal();this.current.post();return this.current;}
  const panel=vscode.window.createWebviewPanel("rung.trace",`${title} · Trace`,vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(ctx.extensionUri,"out","webview")],retainContextWhenHidden:false});
  const instance=this.current=new TracePanel(ctx,panel,model,title);ctx.subscriptions.push(instance);return instance;
 }
 get shown():TraceModel|undefined{return this.model;}
 private post():void{if(this.model)void this.panel.webview.postMessage({kind:"trace",trace:this.model,title:this.title});}
 dispose():void{if(!this.model)return;this.model=undefined;if(TracePanel.current===this)TracePanel.current=undefined;for(const sub of this.subs)sub.dispose();this.panel.dispose();}
}
