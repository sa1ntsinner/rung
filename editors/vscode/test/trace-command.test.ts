// SPDX-License-Identifier: MIT
import {EventEmitter} from "node:events";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
vi.mock("vscode",()=>({window:{showInputBox:vi.fn(),showSaveDialog:vi.fn(),showOpenDialog:vi.fn(),showErrorMessage:vi.fn(),showInformationMessage:vi.fn(),withProgress:vi.fn()},ProgressLocation:{Notification:1},Uri:{file:(fsPath:string)=>({fsPath,scheme:"file"})}}));
vi.mock("../src/commands/targets",()=>({deviceTarget:vi.fn(async()=>"PLC")}));
vi.mock("../src/runner/terminal",()=>({startProcess:vi.fn(),stopLive:vi.fn()}));
vi.mock("../src/trace/panel",()=>({TracePanel:{show:vi.fn()}}));
vi.mock("../src/trace/loader",()=>({loadTrace:vi.fn(async()=>({version:1}))}));
import * as vscode from "vscode";
import {startProcess,stopLive} from "../src/runner/terminal";
import {TraceCommands} from "../src/commands/trace";
import {TracePanel} from "../src/trace/panel";
import type {RungWorkspace} from "../src/workspace";
import type {RungCli} from "../src/runner/cli";
import type {Connector} from "../src/commands/connect";
const roots:string[]=[];afterEach(()=>{roots.forEach(r=>rmSync(r,{recursive:true,force:true}));roots.length=0;vi.clearAllMocks();});
function setup(){const root=mkdtempSync(join(tmpdir(),"rung-trace-ui-"));roots.push(root);writeFileSync(join(root,"rung.toml"),'[project]\npath="one.ap20"');let changed=()=>{};
 const ws={root,hasConfig:true,onDidChange:(fn:()=>void)=>{changed=fn;return {dispose:vi.fn()};}};
 const invocation=vi.fn(()=>({file:"rung",args:[],display:"rung"}));const commands=new TraceCommands({subscriptions:[]} as unknown as vscode.ExtensionContext,ws as unknown as RungWorkspace,{invocation,capture:vi.fn()} as unknown as RungCli,{passwordEnv:vi.fn(async()=>({}))} as unknown as Connector);
 return {root,ws,commands,invocation,changed:()=>changed()};
}
it.each(["root","config"])("refuses %s drift during prompts before starting a recording",async drift=>{
 const s=setup();vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async()=>{if(drift==="root")s.ws.root+="other";else writeFileSync(join(s.root,"rung.toml"),'[project]\npath="two.ap20"');return "DB.a";});
 await s.commands.record({duration:1,interval:100,out:join(s.root,"out.json")});expect(startProcess).not.toHaveBeenCalled();expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/Workspace.*changed/));
});
it("uses pinned root, parent EOF and saved credentials, saves on cancellation before opening",async()=>{
 const s=setup(),child=new EventEmitter();let finish!:(r:unknown)=>void;const done=new Promise(r=>finish=r);
 vi.mocked(startProcess).mockReturnValueOnce({child,done} as unknown as ReturnType<typeof startProcess>);
 vi.mocked(vscode.window.withProgress).mockImplementationOnce(async(_opts,run)=>run({report:vi.fn()}, {onCancellationRequested:(fn:()=>void)=>{fn();finish({code:0,output:"saved"});return {dispose:vi.fn()};}} as unknown as vscode.CancellationToken));
 await s.commands.record({signals:["DB.a"],device:"PLC",duration:1,interval:100,out:join(s.root,"out.json")});
 expect(s.invocation).toHaveBeenCalledWith(expect.arrayContaining(["--dir",s.root,"--parent-stdio"]));expect(startProcess).toHaveBeenCalledWith(expect.anything(),s.root,undefined,{},true);expect(stopLive).toHaveBeenCalledWith(child,30000);expect(TracePanel.show).toHaveBeenCalledTimes(1);
});
it("refuses malformed command options without spawning or replacing files",async()=>{
 const s=setup();await s.commands.record({signals:["DB.a"],duration:"1"} as never);expect(startProcess).not.toHaveBeenCalled();expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/duration/i));
});
it("stops an active lease when config changes, and reports rather than opening failed output",async()=>{
 const s=setup(),child=new EventEmitter();let finish!:(r:unknown)=>void;const done=new Promise(r=>finish=r);
 vi.mocked(startProcess).mockReturnValueOnce({child,done} as unknown as ReturnType<typeof startProcess>);
 vi.mocked(vscode.window.withProgress).mockImplementationOnce(async(_opts,run)=>{
  const running=run({report:vi.fn()},{onCancellationRequested:()=>({dispose:vi.fn()})} as unknown as vscode.CancellationToken);
  writeFileSync(join(s.root,"rung.toml"),'[project]\npath="new.ap20"');s.changed();await new Promise(r=>setTimeout(r,20));finish({code:1,output:"write failed"});return running;
 });
 await s.commands.record({signals:["DB.a"],duration:1,interval:100,out:join(s.root,"out.json")});expect(stopLive).toHaveBeenCalledWith(child,30000);expect(TracePanel.show).not.toHaveBeenCalled();expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringMatching(/write failed.*partial recording/));
});
