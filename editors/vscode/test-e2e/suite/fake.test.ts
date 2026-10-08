// SPDX-License-Identifier: MIT
// Integration tests on the fake-backend workspace (packages/cli/test/fake-bridge.mjs): every view, the
// status bar, CodeLens, every command, compile → Problems, watch, online / connect, download, the LSP.
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RungExtensionApi } from "../../src/extension";
import { CliLog, Dialogs, clearPlcTables, closeAll, file, findItem, openDoc, outline, positionOf, readText, root, rungApi, sleep, waitFor } from "./helpers";

interface FakeDb {
  online?: string;
  onlineTarget?: Record<string, unknown> | null;
  downloads?: { allow: string[]; hardware: boolean; software: boolean; onlyChanges: boolean; startAfter: boolean; target: Record<string, unknown> }[];
  reach?: { pc: string; address: string }[];
  scans?: number;
}

const OBJECTS = process.env.RUNG_E2E_OBJECTS!;
const fakeDb = (): FakeDb => JSON.parse(readFileSync(OBJECTS, "utf8")) as FakeDb;
function patchFake(p: Partial<FakeDb> & Record<string, unknown>): void {
  const db = JSON.parse(readFileSync(OBJECTS, "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) delete db[k];
    else db[k] = v;
  }
  writeFileSync(OBJECTS, JSON.stringify(db));
}

const MOTOR = "plc/PLC_1/blocks/10_Drives/Fx_Motor.scl";
const PUMP = "plc/PLC_1/blocks/10_Drives/Pumps/Fx_Pump.scl";
const BROKEN = "plc/PLC_1/blocks/Fx_Broken.scl";

describe("rung extension on a fake-bridge workspace", function () {
  this.timeout(120_000);
  let api: RungExtensionApi;
  let cli: CliLog;
  const d = new Dialogs();

  before(async () => {
    api = await rungApi();
    cli = new CliLog(api);
    d.install();
    await api.ws.reload();
  });
  after(() => {
    d.uninstall();
    cli.dispose();
  });
  beforeEach(() => {
    d.reset();
    cli.clear();
  });

  describe("activation", () => {
    it("finds the workspace and its objects", () => {
      assert.equal(api.ws.root?.toLowerCase(), root().toLowerCase());
      assert.equal(api.ws.hasConfig, true);
      assert.equal(api.ws.configError, undefined);
      assert.deepEqual(api.ws.devices(), ["PLC_1"]);
      assert.ok(api.ws.objects.length >= 7, `objects: ${api.ws.objects.map((o) => o.path).join(", ")}`);
      assert.deepEqual(api.ws.conflicts, [MOTOR]);
    });

    it("sets the when-clause context keys", async () => {
      const set = new Map<string, unknown>();
      const cmds = vscode.commands as unknown as Record<string, unknown>;
      const orig = cmds.executeCommand as (...a: unknown[]) => Thenable<unknown>;
      cmds.executeCommand = (id: unknown, ...rest: unknown[]) => {
        if (id === "setContext") set.set(rest[0] as string, rest[1]);
        return orig.call(vscode.commands, id, ...rest);
      };
      try {
        await api.ws.reload();
      } finally {
        cmds.executeCommand = orig;
      }
      assert.equal(set.get("rung.workspace"), true);
      assert.equal(set.get("rung.hasObjects"), true);
      assert.equal(set.get("rung.hasConflicts"), true);
    });

    it("registers the rung views and every contributed command", async () => {
      const all = await vscode.commands.getCommands(true);
      for (const id of ["rung.project.focus", "rung.plc.focus", "workbench.view.extension.rung"]) assert.ok(all.includes(id), id);
      const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "package.json"), "utf8")) as { contributes: { commands: { command: string }[] } };
      const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !all.includes(c));
      assert.deepEqual(missing, []);
      await vscode.commands.executeCommand("workbench.view.extension.rung");
      await waitFor("the Project view to be visible", () => api.project.view.visible, 10_000);
    });
  });

  describe("Project view", () => {
    it("shows PLC, sections, TIA folders and objects with conflict and read-only marks", async () => {
      // block types (OB/FB/FC) are read from the file headers in the background
      const text = await waitFor("block type icons", async () => {
        const t = (await outline(api.project)).join("\n");
        return /Main \{[^}]*\} <symbol-event>/.test(t) ? t : undefined;
      });
      assert.match(text, /^PLC_1 \[7 · 1 conflict\] \{rung\.device\} <circuit-board>/m);
      assert.match(text, /^ {2}Program blocks \[6 · 1 conflict\] \{rung\.section\}/m);
      assert.match(text, /^ {4}10_Drives \[2 · 1 conflict\] \{rung\.folder\}/m);
      assert.match(text, /^ {6}Pumps \[1\] \{rung\.folder\}/m);
      assert.match(text, /^ {8}Fx_Pump \{rung\.object compilable testable openable\} <symbol-class>/m);
      assert.match(text, /^ {6}Fx_Motor \[conflict\] \{rung\.object compilable testable openable conflicted\} <warning>/m);
      assert.match(text, /^ {4}Fx_Secret \[read-only\] \{rung\.object openable readonly\} <lock>/m);
      assert.match(text, /^ {4}Main \{[^}]*\} <symbol-event>/m);
      assert.match(text, /^ {4}Fx_Global \{[^}]*\} <database>/m);
      assert.match(text, /^ {2}PLC data types \[1\]/m);
      assert.match(text, /^ {4}Fx_Type /m);
      assert.equal(api.project.view.badge?.value, 1);
    });

    it("groups by block type", async () => {
      await vscode.commands.executeCommand("rung.projectView.groupByKind");
      try {
        await waitFor("block-type groups", async () => (await outline(api.project)).join("\n").includes("Function blocks (FB)"), 10_000);
        const text = (await outline(api.project)).join("\n");
        assert.match(text, /Organization blocks \(OB\) \[1\]/);
        assert.match(text, /Function blocks \(FB\) \[2 · 1 conflict\]/);
        assert.match(text, /Functions \(FC\) \[1\]/);
        assert.match(text, /Data blocks \(DB\) \[1\]/);
        assert.match(text, /Fx_Pump \[10_Drives\/Pumps\]/);
      } finally {
        await vscode.commands.executeCommand("rung.projectView.groupByFolder");
        await vscode.workspace.getConfiguration("rung").update("projectView.grouping", undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it("opens a file from the tree", async () => {
      const { item } = await findItem(api.project, "PLC_1", "Program blocks", "10_Drives", "Pumps", "Fx_Pump");
      assert.ok(item.command, "object items open on click");
      await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
      await waitFor("Fx_Pump.scl in the editor", () => vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file(PUMP).fsPath.toLowerCase());
      assert.equal(vscode.window.activeTextEditor!.document.languageId, "scl");
    });

    it("decorates conflicted and read-only files in the Explorer", () => {
      const conflict = api.decorations.provideFileDecoration(file(MOTOR));
      assert.equal(conflict?.badge, "!");
      assert.equal(api.decorations.provideFileDecoration(file("plc/PLC_1/blocks/Fx_Secret.scl"))?.badge, "R");
      assert.equal(api.decorations.provideFileDecoration(file(PUMP)), undefined);
    });
  });

  describe("PLC view and status bar", () => {
    it("lists watch, the PLC, its connection and the actions", async () => {
      clearPlcTables();
      await api.ws.reload();
      const text = (await outline(api.plc)).join("\n");
      assert.match(text, /^rung watch \[not running\] \{rung\.watch\.stopped\} <circle-slash>/m);
      assert.match(text, /^PLC_1 \[state not checked\] \{rung\.plc\}/m);
      assert.match(text, /^ {2}Connection: found when going online \[or click to choose\] \{rung\.connection\.none\} <search>/m);
      // one row per PLC: its actions are inline buttons and the context menu, not rows
      assert.doesNotMatch(text, /\{rung\.action\}/);
    });

    it("status bar shows the conflict and opens the action list", async () => {
      assert.equal(api.statusBar.visible, true);
      assert.equal(api.statusBar.text, "$(warning) rung · 1 conflict · watch off");
      assert.match(api.statusBar.tooltipText, /conflicts: `plc\/PLC_1\/blocks\/10_Drives\/Fx_Motor\.scl`/);
      let items: vscode.QuickPickItem[] = [];
      d.pick((list) => {
        items = [...list];
        return undefined;
      });
      await vscode.commands.executeCommand("rung.quickPick");
      const labels = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).map((i) => i.label.replace(/\$\([^)]*\)\s*/, ""));
      for (const l of ["Sync now", "Start watch", "Pull from TIA Portal", "Show 1 conflict", "Compile PLC", "Go online", "Connect…", "Download…", "Open rung.toml"]) assert.ok(labels.includes(l), `${l} in ${labels.join(", ")}`);
    });
  });

  describe("editor", () => {
    it("shows Compile · Test · Open in TIA Portal above block headers, never Download", async () => {
      const ed = await openDoc(PUMP);
      const lenses = await waitFor("CodeLens", async () => {
        const l = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", ed.document.uri);
        return l?.length ? l : undefined;
      });
      // Fx_Pump has no test yet: its lens creates one; Fx_Motor's runs its tests
      const titles = (l: vscode.CodeLens[]) => l.map((x) => `${x.range.start.line}:${x.command?.title}`);
      await waitFor("the test files are known", async () => titles((await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", ed.document.uri)) ?? []).includes("0:Create test"));
      assert.deepEqual(titles(lenses).filter((t) => !/Test|test/.test(t)), ["0:Declarations", "0:Compile", "0:Open in TIA Portal"]);
      const motor = await openDoc(MOTOR);
      const motorLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", motor.document.uri);
      assert.deepEqual(titles(motorLenses ?? []), ["0:Declarations", "0:Compile", "0:Test", "0:Open in TIA Portal"]);
      assert.ok(!lenses.some((l) => /download/i.test(l.command?.command ?? "")));
    });

    it("Create test writes a block's first test, runnable as it is, and never overwrites", async () => {
      const ed = await openDoc(PUMP);
      const file = vscode.Uri.file(join(api.ws.root!, "tests", "Fx_Pump.test.yaml"));
      try {
        const made = await vscode.commands.executeCommand<vscode.Uri>("rung.test.create", ed.document.uri, new vscode.Position(0, 0));
        assert.equal(made?.fsPath, file.fsPath);
        const text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
        assert.match(text, /^block: Fx_Pump\ncases:\n {2}- name: first case\n/);
        assert.match(text, /- set: \{ start: false, speed: 0 \}/);
        assert.match(text, /- expect: \{ running: false \}/);
        // asked again: the same file is opened, not written anew
        await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text + "# kept\n"));
        await waitFor("the tests know Fx_Pump", async () => {
          const again = await vscode.commands.executeCommand<vscode.Uri>("rung.test.create", ed.document.uri, new vscode.Position(0, 0));
          return again?.fsPath === file.fsPath;
        });
        assert.match(Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"), /# kept\n$/);
      } finally {
        await closeAll();
        await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
      }
    });

    it("compile this file puts TIA Portal's errors into Problems", async () => {
      const ed = await openDoc(BROKEN);
      await vscode.commands.executeCommand("rung.compileFile");
      const run = cli.find("compile");
      assert.deepEqual(run?.args, ["compile", "--file", BROKEN, "--plc", "PLC_1"]);
      assert.equal(run?.result.code, 2);
      const diags = vscode.languages.getDiagnostics(ed.document.uri).filter((x) => x.source === "TIA Portal");
      assert.equal(diags.length, 1, JSON.stringify(diags));
      assert.equal(diags[0]!.message, "Tag #undeclared not defined");
      assert.equal(diags[0]!.severity, vscode.DiagnosticSeverity.Error);
      assert.equal(diags[0]!.range.start.line, 0);
    });

    it("compile PLC clears the problems of the last compile", async () => {
      await vscode.commands.executeCommand("rung.compilePlc");
      assert.deepEqual(cli.find("compile")?.args, ["compile", "--plc", "PLC_1"]);
      assert.equal(vscode.languages.getDiagnostics(file(BROKEN)).filter((x) => x.source === "TIA Portal").length, 0);
    });

    it("compile on save compiles the saved file", async () => {
      const cfg = vscode.workspace.getConfiguration("rung");
      await cfg.update("compileOnSave", true, vscode.ConfigurationTarget.Workspace);
      try {
        const ed = await openDoc(BROKEN);
        await ed.edit((e) => e.insert(new vscode.Position(2, 0), "\t// saved\n"));
        await ed.document.save();
        const run = await cli.next((f) => f.args[0] === "compile", "compile after save");
        assert.deepEqual(run.args, ["compile", "--file", BROKEN, "--plc", "PLC_1"]);
        await waitFor("problems after save", () => vscode.languages.getDiagnostics(ed.document.uri).some((x) => x.source === "TIA Portal"));
      } finally {
        await cfg.update("compileOnSave", undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it("test this block runs rung test --filter from CodeLens", async () => {
      const ed = await openDoc(MOTOR);
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", ed.document.uri);
      const t = lenses.find((l) => l.command?.title === "Test")!;
      await vscode.commands.executeCommand(t.command!.command, ...(t.command!.arguments ?? []));
      const run = cli.find("test");
      assert.deepEqual(run?.args, ["test", "--filter", "Fx_Motor"]);
      assert.match(run!.result.output, /Fx_Motor: follows start/);
    });

    it("open in TIA Portal explains a TIA Portal without user interface", async () => {
      await openDoc(PUMP);
      await vscode.commands.executeCommand("rung.openInTia");
      assert.deepEqual(cli.find("open")?.args, ["open", PUMP]);
      assert.equal(d.texts.length, 1, d.texts.join("\n"));
      assert.match(d.texts[0]!, /^warning: No TIA Portal window has this project open, so TIA Portal cannot show Fx_Pump/);
    });
  });

  describe("language server", () => {
    it("hover, go to definition and completion on an SCL file", async () => {
      const ed = await openDoc(PUMP);
      const doc = ed.document;
      const body = doc.getText().indexOf("BEGIN");
      const use = positionOf(doc, "#start", 2, body);
      const hovers = await waitFor(
        "a hover from the language server",
        async () => {
          const h = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, use);
          return h?.length ? h : undefined;
        },
        60_000,
        500,
      );
      const hoverText = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
      assert.match(hoverText, /start/i);
      assert.match(hoverText, /Bool/i);

      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", doc.uri, use);
      assert.ok(defs.length, "definition found");
      const range = "targetRange" in defs[0]! ? defs[0].targetSelectionRange ?? defs[0].targetRange : defs[0]!.range;
      assert.equal(range.start.line, positionOf(doc, "start : Bool").line);

      const at = positionOf(doc, "#speed", 1, body);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, at);
      const labels = list.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
      assert.ok(labels.some((l) => /^#?speed$/i.test(l)), `completion: ${labels.slice(0, 30).join(", ")}`);
      assert.ok(labels.some((l) => /^#?running$/i.test(l)), `completion: ${labels.slice(0, 30).join(", ")}`);
    });

    it("quick fix: an FB called without an instance gets its instance DB, like TIA Portal's call options", async () => {
      const ed = await openDoc(PUMP);
      await ed.edit((e) => e.insert(positionOf(ed.document, "END_FUNCTION_BLOCK"), '\t"Fx_Motor"();\n'));
      const db = file("plc/PLC_1/blocks/10_Drives/Pumps/Fx_Motor_DB.db");
      try {
        const at = positionOf(ed.document, '"Fx_Motor"()', 2);
        const actions = await waitFor(
          "quick fixes from the language server",
          async () => {
            const all = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", ed.document.uri, new vscode.Range(at, at), vscode.CodeActionKind.QuickFix.value);
            const a = all?.filter((x) => /instance/i.test(x.title)); // VS Code adds its own "Fix" / "Explain"
            return a?.length ? a : undefined;
          },
          30_000,
          500,
        );
        assert.deepEqual(
          actions.map((a) => a.title),
          ['Create the instance DB "Fx_Motor_DB" and call "Fx_Motor" through it', 'Call "Fx_Motor" as the multi-instance #Fx_Motor_Instance of Fx_Pump'],
        );
        // what VS Code does when the quick fix is chosen: the edit, then the action's command
        const fix = actions[0]!;
        assert.ok(await vscode.workspace.applyEdit(fix.edit!));
        await vscode.commands.executeCommand(fix.command!.command, ...(fix.command!.arguments ?? []));
        const text = await waitFor("the instance DB file", () => (existsSync(db.fsPath) && readFileSync(db.fsPath, "utf8")) || undefined, 10_000);
        assert.match(text, /^DATA_BLOCK "Fx_Motor_DB"\n[\s\S]*\n"Fx_Motor"\n/);
        assert.match(ed.document.getText(), /\t"Fx_Motor_DB"\(\);/);
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.workspace.fs.delete(db).then(undefined, () => {});
        writeFileSync(file(PUMP).fsPath, readFileSync(file(PUMP).fsPath, "utf8").replace('\t"Fx_Motor_DB"();\n', "").replace('\t"Fx_Motor"();\n', ""));
      }
    });

    it("monitoring: the values of the open FB at the end of its lines, through its instance DB, from a virtual PLC", async () => {
      const db = file("plc/PLC_1/blocks/10_Drives/Pumps/Fx_Pump_DB.db");
      writeFileSync(db.fsPath, 'DATA_BLOCK "Fx_Pump_DB"\nVERSION : 0.1\nNON_RETAIN\n"Fx_Pump"\n\nBEGIN\n\nEND_DATA_BLOCK\n');
      const tomlPath = join(root(), "rung.toml");
      const toml = readFileSync(tomlPath, "utf8");
      const inv = api.cli.invocation(["simulate", "--address", "127.0.0.1", "--port", "0", "--cycle", "20"]);
      const sim = spawn(inv.file, inv.args, { cwd: root(), windowsHide: true, windowsVerbatimArguments: inv.shell });
      let simOut = "";
      sim.stdout.on("data", (d: Buffer) => (simOut += d.toString()));
      sim.stderr.on("data", (d: Buffer) => (simOut += d.toString()));
      try {
        const url = await waitFor("rung simulate to listen", () => /virtual PLC at (http:\/\/\S+)/.exec(simOut)?.[1], 30_000);
        writeFileSync(tomlPath, `${toml}\n[live.webapi]\nurl = "${url}"\nuser = "any"\n`);
        process.env.RUNG_WEBAPI_PASSWORD = "x";
        const ed = await openDoc(PUMP);
        const saved = readFileSync(file(PUMP).fsPath, "utf8");
        // an unsaved line above the code: monitoring asks before it saves (a save goes to TIA Portal under watch), so
        // the values stay on their statements
        await ed.edit((e) => e.insert(new vscode.Position(0, 0), "// monitored\n"));
        d.answer("Save and Monitor");
        void api.monitor.toggle(ed.document.uri);
        await waitFor("two reads", () => api.monitor.reads >= 2 || undefined, 30_000, 200);
        assert.equal(ed.document.isDirty, false);
        const plan = api.monitor.plan!;
        assert.equal(plan.instance, '"Fx_Pump_DB"');
        const line = String(positionOf(ed.document, "#running := #start").line);
        writeFileSync(file(PUMP).fsPath, saved);
        assert.deepEqual(plan.lines[line], ["#running", "#start"]);
        assert.equal(api.monitor.values["#start"], true); // Main calls "Fx_Pump_DB"(start := TRUE)
        assert.equal(api.monitor.values["#running"], true);
        await vscode.commands.executeCommand("rung.monitor.stop");
        assert.equal(api.monitor.monitoring, undefined);
      } finally {
        await api.monitor.stop();
        delete process.env.RUNG_WEBAPI_PASSWORD;
        writeFileSync(tomlPath, toml);
        // the shim (rung.cmd) runs rung in a child: end the whole tree, not only cmd.exe
        if (process.platform === "win32" && sim.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(sim.pid)], { windowsHide: true });
        else sim.kill();
        await vscode.workspace.fs.delete(db).then(undefined, () => {});
      }
    });

    it("reports parser diagnostics while typing", async () => {
      const ed = await openDoc(PUMP);
      await ed.edit((e) => e.insert(positionOf(ed.document, "END_FUNCTION_BLOCK"), "\tIF #start THEN\n"));
      try {
        const diags = await waitFor(
          "a diagnostic from the language server",
          () => {
            const list = vscode.languages.getDiagnostics(ed.document.uri).filter((x) => x.source !== "TIA Portal");
            return list.length ? list : undefined;
          },
          30_000,
        );
        assert.ok(diags.some((x) => x.severity === vscode.DiagnosticSeverity.Error), diags.map((x) => x.message).join("; "));
      } finally {
        await vscode.commands.executeCommand("workbench.action.files.revert");
      }
    });
  });

  describe("environment", () => {
    it("lists what rung check finds on this PC, grouped, with what is missing and how to get it", async () => {
      await api.environment.refresh();
      const items = api.environment.items ?? [];
      assert.ok(items.some((i) => i.id === "node" && i.status === "ok"), items.map((i) => `${i.id}:${i.status}`).join(", "));
      const groups = api.environment.getChildren().map((n) => api.environment.getTreeItem(n).label);
      assert.ok(groups.includes("Basics") && groups.includes("PLC platforms"), groups.join(", "));
      const node = api.environment.getChildren().find((n) => api.environment.getTreeItem(n).label === "Basics")!;
      const labels = api.environment.getChildren(node).map((n) => api.environment.getTreeItem(n).label);
      assert.ok(labels.includes("Node.js"), labels.join(", "));
    });
  });

  describe("sync, pull, status", () => {
    it("Changes lists what the next sync does; a plan that moved on meanwhile is shown again, not synced", async () => {
      await vscode.commands.executeCommand("rung.preview");
      assert.ok(api.changes.entries?.some((e) => e.path === "plc/PLC_1/blocks/Fx_Broken.scl" && e.action === "update"), JSON.stringify(api.changes.entries));
      assert.match((await outline(api.changes)).join("\n"), /^To TIA Portal \[1\]/m);
      const seen = api.changes.id;
      const pump = file(PUMP).fsPath;
      const before = readFileSync(pump, "utf8");
      writeFileSync(pump, before.replace("END_FUNCTION_BLOCK", "// moved on\nEND_FUNCTION_BLOCK"));
      try {
        d.reset();
        cli.clear();
        await vscode.commands.executeCommand("rung.changes.sync");
        assert.notEqual(api.changes.id, seen);
        assert.ok(d.texts.some((t) => t.startsWith("warning: The changes moved on while you looked")), d.texts.join("\n"));
        assert.equal(cli.runs.some((r) => r.args[0] === "sync" && !r.args.includes("--preview")), false, cli.lines().join("\n"));
      } finally {
        writeFileSync(pump, before);
      }
    });

    it("sync runs rung sync and points at the conflict", async () => {
      await vscode.commands.executeCommand("rung.sync");
      const run = cli.find("sync");
      assert.equal(run?.result.code, 2);
      assert.match(run!.result.output, /CONFLICT\s+plc\/PLC_1\/blocks\/10_Drives\/Fx_Motor\.scl/);
      await waitFor("the conflict notice", () => d.texts.find((t) => /^warning: 1 conflict: plc\/PLC_1\/blocks\/10_Drives\/Fx_Motor\.scl/.test(t)), 5000);
      assert.ok(vscode.window.terminals.some((t) => t.name === "rung"), "the rung terminal is open");
    });

    it("pull runs rung pull", async () => {
      await vscode.commands.executeCommand("rung.pull");
      const run = cli.find("pull");
      assert.ok(run, cli.lines().join("\n"));
      assert.match(run.result.output, /exported\s+\d+/);
    });

    it("status runs rung status", async () => {
      await vscode.commands.executeCommand("rung.status");
      assert.match(cli.find("status")!.result.output, /edited, not sent plc\/PLC_1\/blocks\/10_Drives\/Fx_Motor\.scl — conflict \(rung resolve/);
    });
  });

  describe("watch", () => {
    it("starts in a terminal, is shown as running, serves commands and stops with Ctrl+C", async () => {
      await vscode.commands.executeCommand("rung.watch.start");
      const term = await waitFor("the rung watch terminal", () => vscode.window.terminals.find((t) => t.name === "rung watch"), 10_000);
      assert.ok(term);
      await waitFor("rung watch to serve (owner.json)", () => api.ws.watching, 60_000, 250);
      await waitFor("status bar", () => api.statusBar.text.includes("rung · 1 conflict") || !api.statusBar.text.includes("watch off"));
      assert.equal(api.watch.status, "running");
      assert.match((await outline(api.plc))[0]!, /^rung watch \[running\] \{rung\.watch\.running\} <sync>/);

      // pull while watch runs: explained instead of a STATE_LOCKED error
      await vscode.commands.executeCommand("rung.pull");
      assert.equal(cli.find("pull"), undefined);
      assert.match(d.texts.join("\n"), /rung watch is running and already keeps the files/);

      // commands go through the running watch
      await vscode.commands.executeCommand("rung.status");
      assert.equal(cli.find("status")?.result.code, 2);

      await vscode.commands.executeCommand("rung.watch.stop");
      await waitFor("watch to stop", () => !api.ws.watching && api.watch.status === "stopped", 30_000);
      await waitFor("the watch terminal to close", () => !vscode.window.terminals.some((t) => t.name === "rung watch"), 10_000);
      assert.match((await outline(api.plc))[0]!, /^rung watch \[not running\]/);
    });

    it("toggle starts and stops", async () => {
      await vscode.commands.executeCommand("rung.watch.toggle");
      await waitFor("rung watch to serve", () => api.ws.watching, 60_000, 250);
      await vscode.commands.executeCommand("rung.watch.toggle");
      await waitFor("watch to stop", () => !api.ws.watching && api.watch.status === "stopped", 30_000);
      assert.deepEqual(d.texts, []);
    });

    const closeWatchTerminals = async () => {
      for (const t of vscode.window.terminals.filter((x) => x.name === "rung watch")) t.dispose();
      await waitFor("watch terminals closed", () => !vscode.window.terminals.some((t) => t.name === "rung watch"), 10_000);
    };

    it("a watch that cannot start is reported instead of 'starting…' forever", async () => {
      const tomlPath = join(root(), "rung.toml");
      const good = readFileSync(tomlPath, "utf8");
      writeFileSync(tomlPath, good.replace('import = "auto"', 'import = "bogus"'));
      try {
        await vscode.commands.executeCommand("rung.watch.start");
        await waitFor("the failure notice", () => d.texts.find((t) => /^warning: rung watch could not start( \(exit code 1\))?: rung: CONFIG_INVALID: .*sync\.import must be auto or manual/.test(t)), 30_000).catch((e: Error) => {
          const t = vscode.window.terminals.find((x) => x.name === "rung watch");
          throw new Error(`${e.message}; said: ${JSON.stringify(d.texts)}; status ${api.watch.status}; terminal exit ${JSON.stringify(t?.exitStatus)}`);
        });
        assert.equal(api.watch.status, "stopped");
        assert.match((await outline(api.plc))[0]!, /^rung watch \[not running\]/);
      } finally {
        writeFileSync(tomlPath, good);
        await closeWatchTerminals();
      }
    });

    it("Ctrl+C typed into the watch terminal: shown as stopped", async () => {
      await vscode.commands.executeCommand("rung.watch.start");
      await waitFor("rung watch to serve", () => api.ws.watching, 60_000, 250);
      vscode.window.terminals.find((t) => t.name === "rung watch")!.sendText("\u0003", false);
      await waitFor("the stopped notice", () => d.texts.find((t) => t.startsWith("warning: rung watch stopped.")), 30_000);
      assert.equal(api.watch.status, "stopped");
      assert.equal(api.statusBar.text.includes("watch off"), true);
      await closeWatchTerminals();
    });

    it("a watch started outside VS Code is shown and left alone", async () => {
      const child = spawn(process.execPath, [join(process.env.RUNG_E2E_REPO!, "packages", "cli", "dist", "index.js"), "watch"], { cwd: root(), stdio: "ignore", windowsHide: true });
      try {
        await waitFor("the outside watch to serve", () => api.ws.watching, 60_000, 250);
        assert.match((await outline(api.plc))[0]!, new RegExp(`^rung watch \\[running outside VS Code \\(pid ${child.pid}\\)\\]`));
        await vscode.commands.executeCommand("rung.watch.start");
        await vscode.commands.executeCommand("rung.watch.stop");
        assert.deepEqual(d.texts, [
          `info: rung watch is already running (pid ${child.pid}), started outside this window.`,
          `info: rung watch (pid ${child.pid}) was started outside this window. Stop it with Ctrl+C in its terminal.`,
        ]);
        assert.equal(vscode.window.terminals.some((t) => t.name === "rung watch"), false);
      } finally {
        child.kill();
      }
      await waitFor("the outside watch to be gone", () => !api.ws.watching, 30_000, 250);
      assert.equal(api.watch.status, "stopped");
    });
  });

  describe("online and connections", () => {
    beforeEach(async () => {
      clearPlcTables();
      patchFake({ reach: undefined, online: "Offline", tiaConfigured: undefined });
      await api.ws.reload();
    });

    it("go online finds the PLC by its project address and shows the connection", async () => {
      await vscode.commands.executeCommand("rung.goOnline");
      assert.deepEqual(cli.find("online")?.args, ["online", "--plc", "PLC_1"]);
      assert.deepEqual(d.texts, []);
      await api.ws.reload();
      assert.equal(api.ws.config?.plc.PLC_1?.pcInterface, "Ethernet");
      assert.equal(api.online.get("PLC_1").state, "Online");
      await waitFor("status bar", () => api.statusBar.text.includes("$(plug) PLC_1 online"));
      const text = (await outline(api.plc)).join("\n");
      assert.match(text, /^PLC_1 \[Online\] \{rung\.plc online\} <pass-filled>/m);
      assert.match(text, /^ {2}Ethernet \[PN\/IE · 1 X1\] \{rung\.connection\} <link>/m);
    });

    it("go offline and online state", async () => {
      await vscode.commands.executeCommand("rung.goOnline");
      await vscode.commands.executeCommand("rung.goOffline");
      assert.deepEqual(cli.find("online")?.args, ["online", "--plc", "PLC_1"]);
      assert.ok(cli.runs.some((r) => r.args.join(" ") === "online --off --plc PLC_1"));
      assert.equal(api.online.get("PLC_1").state, "Offline");
      d.reset();
      await vscode.commands.executeCommand("rung.onlineState");
      assert.deepEqual(d.texts, ["info: Online state: PLC_1: Offline"]);
      await vscode.commands.executeCommand("rung.refreshPlc");
      assert.ok(cli.runs.some((r) => r.args.join(" ") === "online --state --plc PLC_1"));
    });

    it("several interfaces reach the PLC: a quick pick chooses, rung connect --use saves, online retries", async () => {
      patchFake({ reach: [{ pc: "Ethernet", address: "192.168.1.1" }, { pc: "USB-LAN", address: "192.168.0.1" }] });
      let offered: string[] = [];
      d.pick((items) => {
        offered = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator).map((i) => i.label);
        return items.find((i) => i.label.includes("USB-LAN"));
      });
      await vscode.commands.executeCommand("rung.goOnline");
      assert.deepEqual(offered.slice(0, 2), ["plc_1 at 192.168.1.1 (S7-1500) via Ethernet → 1 X2", "plc_1 at 192.168.0.1 (S7-1500) via USB-LAN → 1 X1"]);
      assert.ok(offered.some((l) => /manually/.test(l)));
      const lines = cli.lines();
      assert.deepEqual(lines, ["online --plc PLC_1", "connect --json --plc PLC_1", "connect --use USB-LAN --target 1 X1 --mode PN/IE --number 1 --plc PLC_1", "online --plc PLC_1"]);
      assert.match(readText("rung.toml"), /\[plc\.PLC_1\][\s\S]*pc_interface = "USB-LAN"[\s\S]*target_interface = "1 X1"/);
      assert.equal(fakeDb().online, "Online");
      assert.equal(fakeDb().onlineTarget?.pcInterface, "USB-LAN");
      assert.equal(api.online.get("PLC_1").state, "Online");
    });

    it("the PLC answers under another address: offered as a reachable device", async () => {
      patchFake({ reach: [{ pc: "Wi-Fi", address: "10.0.0.7" }] });
      d.pickLabel(/10\.0\.0\.7/);
      await vscode.commands.executeCommand("rung.goOnline");
      assert.equal(fakeDb().onlineTarget?.pcInterface, "Wi-Fi");
      assert.equal(api.online.get("PLC_1").state, "Online");
    });

    it("nothing found: explains, and Choose manually lists every PG/PC interface", async () => {
      patchFake({ reach: [] });
      d.answer((call) => {
        assert.equal(call.modal, true);
        return "Choose manually";
      });
      let offered: vscode.QuickPickItem[] = [];
      d.pick((items) => {
        offered = [...items];
        return items.find((i) => i.label === "Wi-Fi" && /1 X2/.test(i.description ?? ""));
      });
      await vscode.commands.executeCommand("rung.goOnline");
      const modal = d.of("warning")[0]!;
      assert.equal(modal.message, "PLC_1 was not found on the network.");
      assert.match(modal.detail!, /The project gives it 192\.168\.0\.1 \(PROFINET interface_1\)/);
      assert.match(modal.detail!, /rung looked on: Ethernet, Wi-Fi/);
      assert.deepEqual(modal.items, ["Retry", "Choose manually", "Show details"]);
      assert.deepEqual(
        offered.map((i) => `${i.label} | ${i.description}`),
        ["Ethernet | PN/IE · 1 X1", "Ethernet | PN/IE · 1 X2", "Wi-Fi | PN/IE · 1 X1", "Wi-Fi | PN/IE · 1 X2"],
      );
      assert.deepEqual(cli.lines(), ["online --plc PLC_1", "interfaces --plc PLC_1", "connect --use Wi-Fi --target 1 X2 --mode PN/IE --number 1 --plc PLC_1", "online --plc PLC_1"]);
      assert.equal(api.online.get("PLC_1").state, "Online");
    });

    it("nothing found: Retry scans again, Esc leaves the PLC offline with a clear state", async () => {
      patchFake({ reach: [] });
      d.answer("Retry").answer(undefined);
      await vscode.commands.executeCommand("rung.goOnline");
      assert.deepEqual(cli.lines(), ["online --plc PLC_1", "connect --json --plc PLC_1"]);
      assert.equal(d.of("warning").length, 2);
      assert.equal(api.online.get("PLC_1").error, "not found on the network");
      const text = (await outline(api.plc)).join("\n");
      assert.match(text, /^PLC_1 \[state unknown\]/m);
    });

    it("nothing found: Show details opens the whole explanation", async () => {
      patchFake({ reach: [] });
      d.answer("Show details");
      await vscode.commands.executeCommand("rung.goOnline");
      await waitFor("the explanation document", () => vscode.window.activeTextEditor?.document.getText().includes("rung looked on: Ethernet, Wi-Fi"));
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    });

    it("Connect… always asks and marks the current connection", async () => {
      await vscode.commands.executeCommand("rung.goOnline");
      cli.clear();
      let offered: string[] = [];
      d.pick((items) => {
        offered = items.map((i) => i.label);
        return undefined;
      });
      const { item } = await findItem(api.plc, "PLC_1", "Ethernet");
      assert.equal(item.command?.command, "rung.connect");
      await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
      assert.deepEqual(cli.lines(), ["connect --json --plc PLC_1"]);
      assert.ok(offered.includes("$(check) plc_1 at 192.168.0.1 (S7-1500) via Ethernet → 1 X1"), offered.join(" | "));
    });

    it("a rung.toml that rung connect cannot update is reported, not silently broken", async () => {
      const tomlPath = join(root(), "rung.toml");
      const before = readFileSync(tomlPath, "utf8");
      // an inline table rung does not rewrite: the [plc.PLC_1] it adds makes the file invalid TOML
      writeFileSync(tomlPath, `${before.trimEnd()}\n\n[plc]\nPLC_1 = { mode = "PN/IE", pc_interface = "Ethernet" }\n`);
      try {
        await api.ws.reload();
        d.pickLabel(/via Ethernet/);
        await vscode.commands.executeCommand("rung.connect");
        assert.ok(cli.lines().some((l) => l.startsWith("connect --use Ethernet")));
        assert.match(d.texts.join("\n"), /^error: rung saved the connection, but rung\.toml no longer reads/m);
      } finally {
        writeFileSync(tomlPath, before);
        await api.ws.reload();
      }
    });

    it("Interfaces… scans and saves the chosen interface", async () => {
      d.pickLabel(/^Wi-Fi$/);
      await vscode.commands.executeCommand("rung.interfaces");
      assert.deepEqual(cli.lines(), ["interfaces --scan --plc PLC_1", "connect --use Wi-Fi --target 1 X1 --mode PN/IE --number 1 --plc PLC_1"]);
      await api.ws.reload();
      assert.equal(api.ws.config?.plc.PLC_1?.pcInterface, "Wi-Fi");
    });
  });

  describe("download", () => {
    beforeEach(async () => {
      clearPlcTables();
      patchFake({ reach: undefined, downloads: [] });
      await api.ws.reload();
    });

    const confirmAll = () =>
      d
        .pick((items) => items.filter((i) => i.picked)) // download options as preset
        .answer((c) => (c.message === "Download to PLC_1?" ? "Download" : undefined))
        .input("PLC_1");

    it("finds the connection first, asks with a modal and the typed name, runs in its own terminal, offers the retry TIA asks for", async () => {
      confirmAll();
      d.answer((c) => {
        assert.equal(c.modal, true);
        assert.match(c.message, /TIA Portal cancelled the download to PLC_1\. Retry allowing stop-cpu\?/);
        return "Retry allowing stop-cpu";
      }).input("PLC_1");
      await vscode.commands.executeCommand("rung.download");

      const modal = d.of("warning").find((c) => c.message === "Download to PLC_1?")!;
      assert.equal(modal.modal, true);
      assert.match(modal.detail!, /Connection: Ethernet → 1 X1 \(PN\/IE\)/);
      assert.match(modal.detail!, /Downloads: software \(changes only\)/);
      const inputs = d.of("inputBox");
      assert.equal(inputs.length, 2);
      const validate = (inputs[0]!.options as vscode.InputBoxOptions).validateInput!;
      assert.equal(validate("PLC_1"), undefined);
      assert.match(String(validate("PLC_2")), /Type exactly PLC_1/);

      assert.deepEqual(
        cli.lines().filter((l) => !l.startsWith("online --state")),
        ["connect --json --plc PLC_1", "connect --use Ethernet --target 1 X1 --mode PN/IE --number 1 --plc PLC_1", "download --yes --plc PLC_1", "download --yes --plc PLC_1 --allow stop-cpu"],
      );
      assert.equal(cli.runs.find((r) => r.args[0] === "download")?.result.code, 3);
      assert.ok(vscode.window.terminals.some((t) => t.name === "rung download PLC_1"));
      // the second download runs in its terminal: it is recorded once it has run
      const downloads = await waitFor("both downloads reached the fake PLC", () => (fakeDb().downloads?.length === 2 ? fakeDb().downloads! : undefined), 10_000);
      assert.deepEqual(downloads[0]!.allow, []);
      assert.deepEqual(downloads[1]!.allow, ["stop-cpu"]);
      assert.equal(downloads[1]!.target.pcInterface, "Ethernet");
      await waitFor("the finished message", () => d.texts.includes("info: Download to PLC_1 finished."), 5000);
    });

    it("a wrong or missing name downloads nothing", async () => {
      await vscode.commands.executeCommand("rung.goOnline"); // saves the connection
      cli.clear();
      d.pick((items) => items.filter((i) => i.picked)).answer("Download").input(undefined);
      await vscode.commands.executeCommand("rung.download");
      assert.equal(cli.find("download"), undefined);
      d.reset();
      d.pick((items) => items.filter((i) => i.picked)).answer(undefined);
      await vscode.commands.executeCommand("rung.download");
      assert.equal(cli.find("download"), undefined);
      assert.deepEqual(fakeDb().downloads, []);
    });

    it("the options pick maps onto the command line", async () => {
      await vscode.commands.executeCommand("rung.goOnline");
      cli.clear();
      d.pick((items) => items.filter((i) => /Hardware|All blocks/.test(i.label)))
        .answer("Download")
        .input("PLC_1")
        .answer(undefined);
      await vscode.commands.executeCommand("rung.download");
      assert.deepEqual(cli.find("download")?.args, ["download", "--yes", "--plc", "PLC_1", "--hw", "--no-sw", "--all-blocks", "--no-start"]);
    });
  });

  describe("conflicts", () => {
    it("merge in editor: VS Code's merge editor with your file and TIA Portal's version, the result into the .conflict file", async () => {
      await vscode.commands.executeCommand("rung.resolveMerge", file(MOTOR));
      // the merge editor's tab input (TabInputTextMerge, not in the 1.90 typings): base, input1, input2, result
      type Merge = { base: vscode.Uri; input1: vscode.Uri; input2: vscode.Uri; result: vscode.Uri };
      const tab = await waitFor("the merge editor", () => {
        const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input as Partial<Merge> | undefined;
        return i?.input1 && i.input2 && i.result ? (i as Merge) : undefined;
      });
      assert.equal(tab.result.fsPath, file(MOTOR).fsPath + ".conflict");
      const [mine, tia] = await Promise.all([vscode.workspace.openTextDocument(tab.input1), vscode.workspace.openTextDocument(tab.input2)]);
      assert.doesNotMatch(mine.getText() + tia.getText(), /^(<<<<<<<|=======|>>>>>>>)/m);
      assert.notEqual(mine.getText(), tia.getText());
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });

    it("take TIA version resolves the conflict", async () => {
      d.answer("Take TIA version");
      await vscode.commands.executeCommand("rung.resolveTheirs", file(MOTOR));
      assert.deepEqual(cli.find("resolve")?.args, ["resolve", MOTOR, "--theirs"]);
      await waitFor("no conflicts", async () => {
        await api.ws.reload();
        return api.ws.conflicts.length === 0;
      });
      await waitFor("status bar idle", () => api.statusBar.text.startsWith("$(circle-slash) rung · watch off"));
      assert.equal(api.project.view.badge, undefined);
    });
  });

  describe("compare and rename", () => {
    it("compare with PLC keeps what differs in the Changes view; a row opens the file", async () => {
      patchFake({ compare: undefined, reach: undefined });
      await vscode.commands.executeCommand("rung.compare");
      assert.deepEqual(cli.find("compare")?.args, ["compare", "--json", "--plc", "PLC_1"]);
      const text = (await outline(api.changes)).join("\n");
      assert.match(text, /^PLC_1 · compared \d\d:\d\d \[1 not as in the project · 7 identical\] \{rung\.compared\}/m);
      assert.match(text, /^ {2}Main \[differs\]/m);
      const item = api.changes.getTreeItem({ type: "difference", item: api.changes.comparison!.items[0]! });
      await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
      await waitFor("the differing file", () => vscode.window.activeTextEditor?.document.uri.fsPath.replace(/\\/g, "/").endsWith("plc/PLC_1/blocks/Main.scl"));
    });

    it("compare says so when the PLC runs the project", async () => {
      patchFake({ compare: [] });
      await vscode.commands.executeCommand("rung.compare");
      await waitFor("the notice", () => d.texts.find((t) => /^info: PLC_1 runs what the project has \(7 objects compared\)\.$/.test(t)));
    });

    it("rename asks for the new name, renames in TIA Portal and opens the renamed file", async () => {
      await openDoc(PUMP);
      d.input("Fx_Pump2");
      await vscode.commands.executeCommand("rung.rename");
      assert.deepEqual(cli.find("rename")?.args, ["rename", PUMP, "Fx_Pump2"]);
      assert.equal(d.of("inputBox")[0]?.message, "Rename Fx_Pump in TIA Portal");
      await waitFor("the renamed file", () => vscode.window.activeTextEditor?.document.uri.fsPath.replace(/\\/g, "/").endsWith("Pumps/Fx_Pump2.scl"));
      assert.match(readText("plc/PLC_1/blocks/10_Drives/Pumps/Fx_Pump2.scl"), /FUNCTION_BLOCK "Fx_Pump2"/);
      // back, so later tests see the fixture as it was
      d.input("Fx_Pump");
      await vscode.commands.executeCommand("rung.rename");
      await waitFor("the name back", () => vscode.window.activeTextEditor?.document.uri.fsPath.replace(/\\/g, "/").endsWith(PUMP));
    });
  });

  describe("every palette command", () => {
    // Commands with their own tests above that start long-running things are left out here.
    const OWN_TEST = new Set(["rung.watch.start", "rung.watch.toggle", "rung.watch.stop"]);

    it("runs without throwing when every dialog is dismissed", async () => {
      const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "package.json"), "utf8")) as { contributes: { commands: { command: string }[] } };
      await openDoc(PUMP);
      const failures: string[] = [];
      for (const { command } of pkg.contributes.commands) {
        if (OWN_TEST.has(command)) continue;
        d.reset();
        try {
          await vscode.commands.executeCommand(command);
        } catch (e) {
          failures.push(`${command}: ${(e as Error).message}`);
        }
        await sleep(50);
        const said = [...d.texts, ...d.of("quickPick").map((q) => `quickPick: ${q.message}`)];
        const tail = said.map((t) => `\n        ${t.replace(/\r?\n/g, " / ")}`).join("");
        console.log(`      ${command}: ${cli.lines().join(" ; ") || "(no CLI)"}${tail}`);
        cli.clear();
      }
      assert.deepEqual(failures, []);
      assert.equal(vscode.window.terminals.some((t) => t.name === "rung watch"), false);
    });
  });

  describe("declarations", () => {
    it("opens beside the SCL editor, follows it and changes nothing", async () => {
      await closeAll();
      const editor = await openDoc(MOTOR);
      await vscode.commands.executeCommand("rung.declarations.open");
      const tab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("rung.declarations"));
      await waitFor("the declarations panel opened", () => !!tab());
      await waitFor("the panel is titled after the block", () => /Fx_Motor/.test(tab()!.label));
      assert.notEqual(tab()!.group.viewColumn, editor.viewColumn);
      assert.equal(editor.document.isDirty, false);
      await openDoc(PUMP);
      await waitFor("the panel followed the active SCL editor", () => /Fx_Pump/.test(tab()?.label ?? ""));
      await closeAll();
    });

    it("edits from the table change the document: a default, add, delete, rename; undo restores; a stale edit is refused", async () => {
      await closeAll();
      const editor = await openDoc(PUMP);
      const doc = editor.document;
      const original = doc.getText();
      await vscode.commands.executeCommand("rung.declarations.open");
      const panel = await waitFor("the panel shows Fx_Pump", () => (api.declarations()?.shown?.block?.name === "Fx_Pump" ? api.declarations() : undefined));
      const shown = () => panel.shown!;
      const send = (m: Record<string, unknown>) => panel.receive({ v: 1, req: 1, uri: shown().uri, version: shown().version, ...m });
      const fresh = (v: number) => waitFor("the table has the new text", () => shown().version > v);

      let v = shown().version;
      assert.deepEqual(await send({ kind: "edit", op: { op: "setStart", row: "speed", value: "5" } }), { v: 1, kind: "result", req: 1, ok: true });
      assert.match(doc.getText(), /speed : Int := 5;/);
      assert.equal(doc.isDirty, true);
      await fresh(v);
      // the edit made on the old text is refused, nothing changes
      const stale = await panel.receive({ v: 1, kind: "edit", req: 2, uri: shown().uri, version: v, op: { op: "setStart", row: "speed", value: "6" } });
      assert.deepEqual(stale, { v: 1, kind: "result", req: 2, ok: false, reason: "The file changed. Review this value again." });
      assert.match(doc.getText(), /speed : Int := 5;/);

      v = shown().version;
      assert.deepEqual(await send({ kind: "add", after: "running" }), { v: 1, kind: "result", req: 1, ok: true, edit: { rowId: "Tag_1", column: "name" } });
      assert.match(doc.getText(), /running : Bool;\r?\n {6}Tag_1 : Bool;\r?\n/);
      await fresh(v);
      v = shown().version;
      assert.deepEqual(await send({ kind: "delete", rowId: "Tag_1" }), { v: 1, kind: "result", req: 1, ok: true });
      assert.doesNotMatch(doc.getText(), /Tag_1/);
      await fresh(v);

      // a rename goes through the language server: the code follows
      assert.deepEqual(await send({ kind: "rename", rowId: "running", name: "isRunning" }), { v: 1, kind: "result", req: 1, ok: true });
      assert.match(doc.getText(), /isRunning : Bool;/);
      assert.match(doc.getText(), /#isRunning := FALSE;/);

      // the view's undo is the document's: back to where it started, one step per edit
      for (let i = 0; i < 4; i++) await panel.receive({ v: 1, kind: "undo" });
      assert.equal(doc.getText(), original);
      await vscode.commands.executeCommand("workbench.action.files.revert", doc.uri);
      await closeAll();
    });

    it("a UDT opens as a table; its edits are text edits of the file, undone by VS Code's undo", async () => {
      await closeAll();
      const uri = vscode.Uri.file(join(api.ws.root!, "plc/PLC_1/types/Fx_Type.udt"));
      await vscode.commands.executeCommand("rung.udt.openTable", uri);
      const session = await waitFor("the UDT table shows Fx_Type", () => {
        const s = api.udtTables.get(uri.toString());
        return s?.shown?.block?.name === "Fx_Type" ? s : undefined;
      });
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())!;
      const original = doc.getText();
      const r = await session.receive({ v: 1, kind: "edit", req: 1, uri: uri.toString(), version: session.shown!.version, op: { op: "setStart", row: "a", value: "TRUE" } });
      assert.deepEqual(r, { v: 1, kind: "result", req: 1, ok: true });
      assert.match(doc.getText(), /a : Bool := TRUE;/);
      assert.equal(doc.isDirty, true);
      await session.receive({ v: 1, kind: "undo" });
      await waitFor("undo restored the UDT", () => doc.getText() === original);
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
      await closeAll();
    });

    it("a test file opens as a table: an edit is a text edit undone by undo; a case runs through the test explorer", async () => {
      await closeAll();
      // Fx_Motor is in conflict in this workspace: the table tests Fx_Pump
      const uri = vscode.Uri.file(join(api.ws.root!, "tests", "pump.test.yaml"));
      const yaml = ["block: Fx_Pump", "cases:", "  - name: follows start", "    steps:", "      - set: { start: true }", "      - cycle: 1", "      - expect: { running: true }", ""].join("\n");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(yaml));
      await vscode.commands.executeCommand("rung.test.openTable", uri);
      const table = await waitFor("the test table shows the file", () => {
        const t = api.testTables.get(uri.toString());
        return t?.shown?.model.cases.length ? t : undefined;
      });
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())!;
      const original = doc.getText();
      assert.deepEqual(table.shown!.model.cases.map((c) => c.name?.value), ["follows start"]);
      assert.deepEqual(table.shown!.symbols.map((s) => s.name), ["start", "speed", "running"]);
      const r = await table.receive({ v: 1, kind: "edit", req: 1, uri: uri.toString(), version: table.shown!.version, op: { op: "setValue", case: 0, step: 2, part: "expect", key: "running", value: "false" } });
      assert.deepEqual(r, { v: 1, kind: "result", req: 1, ok: true });
      assert.match(doc.getText(), /expect: \{ running: false \}/);
      assert.equal(doc.isDirty, true);
      await table.receive({ v: 1, kind: "undo" });
      await waitFor("undo restored the test", () => doc.getText() === original);
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
      await table.receive({ v: 1, kind: "run", case: 0 });
      const runs = await waitFor("the run's result reached the table", () => {
        const m = (table as unknown as { last?: { kind: string; runs?: { index: number }[] } }).last;
        return m?.kind === "runs" && m.runs?.length ? m.runs : undefined;
      }, 120_000);
      assert.deepEqual(runs.map((x) => x.index), [0]);
      assert.deepEqual(cli.find("test")?.args.slice(0, 4), ["test", "--json", "--case", "tests/pump.test.yaml#0"]);
      await closeAll();
      await vscode.workspace.fs.delete(uri);
    });

    it("colours SCL names by what they are (semantic tokens)", async () => {
      const ed = await openDoc(PUMP);
      const tokens = await waitFor("semantic tokens", async () => {
        const t = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", ed.document.uri);
        return t?.data.length ? t : undefined;
      }, 60_000);
      const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", ed.document.uri);
      assert.ok(legend.tokenTypes.includes("parameter") && legend.tokenModifiers.includes("readonly"), JSON.stringify(legend));
      assert.equal(tokens.data.length % 5, 0);
      assert.equal(vscode.workspace.getConfiguration("editor", { languageId: "scl" }).get("semanticHighlighting.enabled"), true);
    });

    it("Record Expectations writes the values the engineer picks into the step under the cursor", async () => {
      await closeAll();
      const uri = vscode.Uri.file(join(api.ws.root!, "tests", "rec.test.yaml"));
      const yaml = ["block: Fx_Pump", "cases:", "  - name: fast stops", "    steps:", "      - set: { start: true, speed: 200 }", "      - cycle: 1", ""].join("\n");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(yaml));
      try {
        const ed = await vscode.window.showTextDocument(uri);
        ed.selection = new vscode.Selection(5, 8, 5, 8); // on "cycle: 1"
        await waitFor("the language server reads the test file", () => api.lsp.request("rung/testModel", { textDocument: { uri: uri.toString() } }).then((m) => m ?? undefined, () => undefined), 60_000);
        let offered: string[] = [];
        d.pick((items) => {
          offered = items.map((i) => i.label);
          return items.filter((i) => i.label.startsWith("running"));
        });
        assert.equal(await vscode.commands.executeCommand("rung.test.record"), true, JSON.stringify(d.calls.map((c) => c.message)));
        assert.ok(offered.includes("running = false"), offered.join(", "));
        assert.match(ed.document.getText(), /- cycle: 1\n {8}expect: \{ running: false \}\n/);
        // the case passes as recorded
        const r = await api.cli.capture(["test", "--json", "--case", "tests/rec.test.yaml#0"], { quiet: true });
        assert.match(r.output, /"passed": true/);
      } finally {
        d.reset();
        await closeAll();
        await vscode.workspace.fs.delete(uri);
      }
    });

    it("Run with Coverage marks the SCL lines the cases ran and the ones they never reached", async () => {
      const uri = vscode.Uri.file(join(api.ws.root!, "tests", "cov.test.yaml"));
      const yaml = ["block: Fx_Pump", "cases:", "  - name: slow keeps running", "    steps:", "      - set: { start: true, speed: 50 }", "      - cycle: 1", ""].join("\n");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(yaml));
      try {
        const pump = vscode.Uri.file(join(api.ws.root!, PUMP));
        const lines = Buffer.from(await vscode.workspace.fs.readFile(pump)).toString("utf8").split(/\r?\n/);
        const ifLine = lines.findIndex((l) => l.includes("IF #speed > 100"));
        const inside = lines.findIndex((l) => l.includes("#running := FALSE"));
        await api.tests()!.discoverNow();
        await vscode.commands.executeCommand("testing.coverageAll");
        const details = await waitFor("coverage of Fx_Pump", () => api.tests()!.coverageOf(pump), 120_000);
        const count = (line: number) => details.find((d) => (d.location as vscode.Position).line === line)?.executed;
        assert.equal(count(ifLine), 1);
        assert.equal(count(inside), 0); // speed 50: the IF's body never ran
      } finally {
        await vscode.workspace.fs.delete(uri);
      }
    });

    it("debugs a test case: stops at a breakpoint in the block, evaluates, steps back, reports the result", async () => {
      await closeAll();
      const uri = vscode.Uri.file(join(api.ws.root!, "tests", "dbg.test.yaml"));
      const yaml = ["block: Fx_Pump", "cases:", "  - name: too fast stops", "    steps:", "      - set: { start: true, speed: 200 }", "      - cycle: 1", "      - expect: { running: false }", ""].join("\n");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(yaml));
      const pump = vscode.Uri.file(join(api.ws.root!, PUMP));
      const lines = Buffer.from(await vscode.workspace.fs.readFile(pump)).toString("utf8").split(/\r?\n/);
      const target = lines.findIndex((l) => l.includes("#running := FALSE"));
      const ifLine = lines.findIndex((l) => l.includes("IF #speed > 100"));
      const bp = new vscode.SourceBreakpoint(new vscode.Location(pump, new vscode.Position(target, 0)));
      vscode.debug.addBreakpoints([bp]);
      const seen: { type: string; event?: string; body?: { output?: string } }[] = [];
      const tracker = vscode.debug.registerDebugAdapterTrackerFactory("rung", { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => void seen.push(m) }) });
      const events = (name: string) => seen.filter((m) => m.type === "event" && m.event === name).length;
      try {
        const started = await vscode.debug.startDebugging(undefined, { type: "rung", request: "launch", name: "Debug too fast stops", test: uri.fsPath, case: 0 });
        assert.equal(started, true, JSON.stringify(seen));
        await waitFor("stopped at the breakpoint", () => events("stopped") === 1, 60_000);
        const session = vscode.debug.activeDebugSession!;
        const top = async () => ((await session.customRequest("stackTrace", { threadId: 1 })) as { stackFrames: { line: number; name: string }[] }).stackFrames[0]!;
        assert.deepEqual(await top(), { ...(await top()), name: "Fx_Pump", line: target + 1 });
        assert.equal(((await session.customRequest("evaluate", { expression: "speed", frameId: 0 })) as { result: string }).result, "200");
        const inline = await vscode.commands.executeCommand<vscode.InlineValue[]>("vscode.executeInlineValueProvider", pump, new vscode.Range(0, 0, target, 0), { frameId: 0, stoppedLocation: new vscode.Range(target, 0, target, 0) });
        assert.ok(inline.some((v) => (v as vscode.InlineValueVariableLookup).variableName === "speed" && v.range.start.line === ifLine), JSON.stringify(inline));
        await session.customRequest("stepBack", { threadId: 1 });
        await waitFor("stopped one statement back", () => events("stopped") === 2);
        assert.equal((await top()).line, ifLine + 1);
        await session.customRequest("continue", { threadId: 1 });
        await waitFor("the breakpoint again", () => events("stopped") === 3);
        assert.equal((await top()).line, target + 1);
        await session.customRequest("continue", { threadId: 1 });
        await waitFor("the case ran to its end", () => events("terminated") > 0);
        assert.match(seen.filter((m) => m.event === "output").map((m) => m.body?.output).join(""), /passed: too fast stops/);
      } finally {
        tracker.dispose();
        vscode.debug.removeBreakpoints([bp]);
        await vscode.debug.stopDebugging();
        await vscode.workspace.fs.delete(uri);
      }
    });

    it("who writes a name fills the Usages tree, which stays while you open its places", async () => {
      const editor = await openDoc(MOTOR);
      const at = editor.document.getText().indexOf("#running") + 2;
      editor.selection = new vscode.Selection(editor.document.positionAt(at), editor.document.positionAt(at));
      await vscode.commands.executeCommand("rung.whoWrites");
      const groups = await waitFor("the Usages tree has groups", () => {
        const g = api.usages.getChildren();
        return g.length > 1 ? g : undefined;
      });
      assert.equal(groups[0]!.label, "Writes");
      assert.equal(groups.at(-1)!.label, "Workspace code only");
      await closeAll();
    });
  });

  after(async () => {
    await closeAll();
  });
});
