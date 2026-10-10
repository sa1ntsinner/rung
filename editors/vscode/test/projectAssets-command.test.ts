// SPDX-License-Identifier: MIT
import {expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
vi.mock("vscode",()=>({window:{showWarningMessage:vi.fn(),showErrorMessage:vi.fn(),showTextDocument:vi.fn()},workspace:{textDocuments:[],openTextDocument:vi.fn()}}));
vi.mock("../src/commands/targets",()=>({deviceTarget:vi.fn()}));
import * as vscode from "vscode";
import {projectAssets} from "../src/commands/projectAssets";
import type {Services} from "../src/commands/index";
it.each(["root","config"])("refuses %s drift between reviewed preview and apply",async drift=>{
 const root=mkdtempSync(join(tmpdir(),"rung-assets-guard-"));writeFileSync(join(root,"rung.toml"),'[project]\npath="first.ap20"\n');const ws={hasConfig:true,root};const capture=vi.fn().mockResolvedValue({code:0,output:JSON.stringify({revision:"a".repeat(64)})});
 vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async()=>{if(drift==="root")ws.root=root+"-other";else writeFileSync(join(root,"rung.toml"),'[project]\npath="second.ap20"\n');return "Apply reviewed change" as never;});vi.mocked(vscode.window.showErrorMessage).mockClear();
 await projectAssets({ws,cli:{capture}} as unknown as Services,{action:"library-release",typeGuid:"t",versionGuid:"v",number:"1.0.0",author:"smile",comment:"",apply:true});
 expect(capture).toHaveBeenCalledTimes(1);expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Workspace.*changed/));
});
