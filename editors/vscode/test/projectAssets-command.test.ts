// SPDX-License-Identifier: MIT
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
vi.mock("vscode",()=>({window:{showWarningMessage:vi.fn(),showErrorMessage:vi.fn(),showTextDocument:vi.fn()},workspace:{textDocuments:[],openTextDocument:vi.fn()}}));
vi.mock("../src/commands/targets",()=>({deviceTarget:vi.fn()}));
import * as vscode from "vscode";
import {projectAssets} from "../src/commands/projectAssets";
import type {Services} from "../src/commands/index";
import {parseRungToml} from "../src/core/rungToml";
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it("blocks apply options passed directly to the preview command under the environment lock",async()=>{
 vi.stubEnv("RUNG_READ_ONLY","1");const capture=vi.fn();
 await projectAssets({ws:{hasConfig:true,reload:async()=>{}},cli:{capture}} as unknown as Services,{action:"library-release",typeGuid:"t",versionGuid:"v",number:"1.0.0",author:"smile",comment:"",apply:true});
 expect(capture).not.toHaveBeenCalled();expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("RUNG_READ_ONLY=1"));
});
it("reloads PLC locks before an apply request",async()=>{
 vi.stubEnv("RUNG_READ_ONLY","0");const capture=vi.fn();
 const ws={hasConfig:true,config:undefined as ReturnType<typeof parseRungToml>|undefined,reload:async()=>{ws.config=parseRungToml('[live.plc.A]\ntransport="s7commplus"\naddress="192.0.2.1"\nread_only=true');}};
 await projectAssets({ws,cli:{capture}} as unknown as Services,{action:"library-release",apply:true});
 expect(capture).not.toHaveBeenCalled();expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("PLC A"));
});
it.each(["root","config"])("refuses %s drift between reviewed preview and apply",async drift=>{
 const root=mkdtempSync(join(tmpdir(),"rung-assets-guard-"));writeFileSync(join(root,"rung.toml"),'[project]\npath="first.ap20"\n');const ws={hasConfig:true,root,reload:async()=>{}};const capture=vi.fn().mockResolvedValue({code:0,output:JSON.stringify({revision:"a".repeat(64)})});
 vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async()=>{if(drift==="root")ws.root=root+"-other";else writeFileSync(join(root,"rung.toml"),'[project]\npath="second.ap20"\n');return "Apply reviewed change" as never;});vi.mocked(vscode.window.showErrorMessage).mockClear();
 await projectAssets({ws,cli:{capture}} as unknown as Services,{action:"library-release",typeGuid:"t",versionGuid:"v",number:"1.0.0",author:"smile",comment:"",apply:true});
 expect(capture).toHaveBeenCalledTimes(1);expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Workspace.*changed/));
});
