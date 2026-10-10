// SPDX-License-Identifier: MIT
import {join,dirname,basename,resolve} from "node:path";
import * as vscode from "vscode";
import {assetPreviewArgs,assetApplyArgs,assetFileHash,type AssetRequest} from "../core/projectAssets";
import {deviceTarget} from "./targets";
import type {Services} from "./index";
const ACTIONS=[{label:"Preview or apply hardware YAML/JSON",action:"hardware"},{label:"Import library package",action:"library-import"},{label:"Release library version",action:"library-release"},{label:"Update used library definition",action:"library-update"},{label:"Edit alarm text workbook",action:"alarms"},{label:"Edit technology XML",action:"technology"},{label:"Export alarm workbook",action:"export-alarms"},{label:"Export technology XML",action:"export-technology"},{label:"Export library version",action:"export-library"},{label:"List library identities",action:"libraries"},{label:"Observe safety signatures (read-only)",action:"safety"}] as const;
export interface ProjectAssetsOptions extends Omit<AssetRequest,"action">{action?:AssetRequest["action"]|"libraries"|"safety"|"export-alarms"|"export-technology"|"export-library";exportPath?:string;apply?:boolean;}
export async function projectAssets(s:Services,options:ProjectAssetsOptions={}):Promise<void>{
 if(!s.ws.hasConfig){void vscode.window.showWarningMessage("Open a rung workspace first.");return;}
 const action=options.action??(await vscode.window.showQuickPick(ACTIONS,{title:"Project Assets"}))?.action;if(!action)return;
 const request={...options,action} as AssetRequest;
 async function input(key:keyof AssetRequest,title:string,value?:string){if(request[key]!==undefined)return;const text=await vscode.window.showInputBox({title,value,ignoreFocusOut:true});if(text===undefined)throw new Error("Cancelled");Object.assign(request,{[key]:text});}
 try{
  const deviceActions=["library-import","library-update","alarms","technology","export-alarms","export-technology","safety"];
  if(deviceActions.includes(action)){request.device=await deviceTarget(s.ws,options.device,"Project Assets");if(!request.device)return;}
  if(action==="technology"||action==="export-technology")await input("name","Technology object name");
  if(action==="library-release"||action==="library-update"||action==="export-library"){await input("typeGuid","Project library type GUID");await input("versionGuid",action==="library-update"?"Released default version GUID":"Library version GUID");}
  if(action==="library-release"){await input("number","Released version (major.minor.patch)");await input("author","Release author");await input("comment","Release comment","");}
  if(action==="libraries"||action==="safety"){await s.cli.capture(action==="libraries"?["library","--json"]:["safety","--device",request.device!,"--json"],{progress:"Read project assets"});return;}
  if(action.startsWith("export-")){let destination=options.exportPath;if(!destination){if(action==="export-library")destination=await vscode.window.showInputBox({title:"New library package directory",value:join(s.ws.root!,"library-export")});else destination=(await vscode.window.showSaveDialog({title:"Export native project artifact",defaultUri:vscode.Uri.file(join(s.ws.root!,action==="export-alarms"?"alarms.xlsx":"technology.xml"))}))?.fsPath;}if(!destination)return;await s.cli.capture(action==="export-library"?["library","--type-guid",request.typeGuid!,"--version-guid",request.versionGuid!,"--export",destination,"--json"]:[action==="export-alarms"?"alarms":"technology","--device",request.device!,...(request.name?["--name",request.name]:[]),"--export",destination,"--json"],{progress:"Export native project artifact"});return;}
  if(["hardware","library-import","alarms","technology"].includes(action)&&!request.file){request.file=(await vscode.window.showOpenDialog({canSelectMany:false,title:"Choose the edited project artifact"}))?.[0]?.fsPath;if(!request.file)return;}
  const root=s.ws.root!;const configRevision=await assetFileHash(join(root,"rung.toml"),1048576);
  const files=request.file?[resolve(root,request.file)]:[];if(action==="library-import"&&files[0])files.push(join(dirname(files[0]),basename(files[0]).replace(/\.libinfo$/,".xml")));
  const pathKey=(path:string)=>process.platform==="win32"?resolve(path).toLowerCase():resolve(path);
  const dirty=()=>vscode.workspace.textDocuments.some(d=>d.isDirty&&files.some(f=>pathKey(f)===pathKey(d.uri.fsPath)));if(dirty())throw new Error("Save the artifact and its paired document before previewing.");
  const limit=action==="hardware"||action==="library-import"?1048576:4*1048576;
  const fileRevision=files[0]?await assetFileHash(files[0],limit):undefined;
  const inRoot=(args:string[])=>[args[0]!,root,...args.slice(1)];
  const unchanged=async()=>{if(s.ws.root!==root||await assetFileHash(join(root,"rung.toml"),1048576)!==configRevision||s.ws.root!==root)throw new Error("Workspace or configuration changed; preview again.");};
  await unchanged();const result=await s.cli.capture(inRoot(assetPreviewArgs(request)),{progress:"Preview project asset changes"});if(result.code!==0)return;
  const preview=JSON.parse(result.output);const document=await vscode.workspace.openTextDocument({language:"json",content:JSON.stringify(preview,null,2)});await vscode.window.showTextDocument(document,{preview:true});
  if(!options.apply)return;
  const answer=await vscode.window.showWarningMessage("Apply the displayed project asset changes?",{modal:true},"Apply reviewed change");if(answer!=="Apply reviewed change")return;if(dirty())throw new Error("Artifact has unsaved changes; preview again.");
  if(files[0]&&await assetFileHash(files[0],limit)!==fileRevision)throw new Error("Artifact changed after preview; preview again.");
  await unchanged();await s.cli.capture(inRoot(assetApplyArgs(request,preview,fileRevision)),{progress:"Apply reviewed project asset change"});
 }catch(error){const message=error instanceof Error?error.message:String(error);if(message!=="Cancelled")void vscode.window.showErrorMessage(message);}
}
