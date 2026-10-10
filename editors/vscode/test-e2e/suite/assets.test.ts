// SPDX-License-Identifier: MIT
// Offline, disposable native fixture only; no PLC connection or download.
import * as assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import * as vscode from "vscode";
import {Dialogs,root,rungApi,closeAll} from "./helpers";
import type {ProjectAssetsOptions} from "../../src/commands/projectAssets";
describe("offline project assets in the actual editor",function(){
 this.timeout(600_000);
 it("reviews and restores hardware, alarm and technology changes, updates a used library, and observes unavailable safety",async()=>{
  const api=await rungApi(),dialogs=new Dialogs();dialogs.install();await api.ws.reload();
  const evidence=JSON.parse(readFileSync(process.env.RUNG_E2E_ASSET_EVIDENCE!,"utf8")) as {typeGuid:string;versionGuid:string;alarmOriginal:string;alarmEdited:string;technologyOriginal:string;technologyEdited:string;fixtureProject:string};
  assert.match(evidence.fixtureProject,/rung-fixtures[\\/]item4-restored-20261009[\\/]/);assert.ok(readFileSync(join(evidence.fixtureProject.substring(0,evidence.fixtureProject.lastIndexOf("/")),".rung-fixture")));
  async function cli(args:string[]){const result=await api.cli.capture(args);assert.equal(result.code,0,result.output);return JSON.parse(result.output);}
  async function apply(options:ProjectAssetsOptions){dialogs.reset();dialogs.answer("Apply reviewed change");await vscode.commands.executeCommand("rung.projectAssets",{...options,apply:true});assert.ok(dialogs.calls.some(c=>c.modal&&c.items.includes("Apply reviewed change")),JSON.stringify(dialogs.calls));assert.ok(!dialogs.calls.some(c=>c.kind==="error"),JSON.stringify(dialogs.calls));}
  try{
   const safety=await cli(["safety","--device","PLC_1","--json"]);assert.equal(safety.status,"unavailable");assert.equal(safety.signatures,undefined);await vscode.commands.executeCommand("rung.projectAssets",{action:"safety",device:"PLC_1"});
   await vscode.commands.executeCommand("rung.projectAssets",{action:"libraries"});
   const snapshot=await cli(["hardware","--json"]),patch=join(root(),"hardware-editor.json");
   const change={device:"PLC_1",positions:[1],typeIdentifier:"OrderNumber:6ES7 516-3AN02-0AB0/V2.9",field:"Comment",before:"",after:"Editor offline proof"};
   writeFileSync(patch,JSON.stringify({version:1,expectedRevision:snapshot.revision,changes:[change]}));await apply({action:"hardware",file:patch});
   const changed=await cli(["hardware","--json"]);writeFileSync(patch,JSON.stringify({version:1,expectedRevision:changed.revision,changes:[{...change,before:change.after,after:change.before}]}));await apply({action:"hardware",file:patch});assert.equal((await cli(["hardware","--json"])).revision,snapshot.revision);
   await apply({action:"alarms",device:"PLC_1",file:evidence.alarmEdited});const alarmPreview=await cli(["alarms","--device","PLC_1","--file",evidence.alarmOriginal,"--preview","--json"]);assert.equal(alarmPreview.changes[0].original,"Running");await apply({action:"alarms",device:"PLC_1",file:evidence.alarmOriginal});assert.equal((await cli(["alarms","--device","PLC_1","--file",evidence.alarmOriginal,"--preview","--json"])).changes.length,0);
   await apply({action:"technology",device:"PLC_1",name:"RungPID_Probe",file:evidence.technologyEdited});assert.equal((await api.cli.capture(["compile","--plc","PLC_1"])).code,0);
   await apply({action:"technology",device:"PLC_1",name:"RungPID_Probe",file:evidence.technologyOriginal});assert.equal((await api.cli.capture(["compile","--plc","PLC_1"])).code,0);
   const toExport=join(root(),"technology-editor-restored.xml");await vscode.commands.executeCommand("rung.projectAssets",{action:"export-technology",device:"PLC_1",name:"RungPID_Probe",exportPath:toExport});assert.deepEqual(readFileSync(toExport),readFileSync(evidence.technologyOriginal));
   await apply({action:"library-update",device:"PLC_1",typeGuid:evidence.typeGuid,versionGuid:evidence.versionGuid});assert.equal((await api.cli.capture(["compile","--plc","PLC_1"])).code,0);
   const doc=await vscode.workspace.openTextDocument(patch),editor=await vscode.window.showTextDocument(doc);await editor.edit(e=>e.insert(new vscode.Position(0,0)," "));dialogs.reset();await vscode.commands.executeCommand("rung.projectAssets",{action:"hardware",file:patch});assert.ok(dialogs.calls.some(c=>c.kind==="error"&&c.message.includes("Save the artifact")));await vscode.commands.executeCommand("workbench.action.files.revert");
  }finally{dialogs.uninstall();await closeAll();}
 });
});
