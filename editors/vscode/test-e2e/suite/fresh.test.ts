// SPDX-License-Identifier: MIT
// First run: a folder without rung.toml. Open TIA Project mirrors, pulls and starts watch; the views fill.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { RungExtensionApi } from "../../src/extension";
import { CliLog, Dialogs, outline, rungApi, waitFor } from "./helpers";

describe("first run in a folder without rung.toml", function () {
  this.timeout(120_000);
  let api: RungExtensionApi;
  let cli: CliLog;
  const d = new Dialogs();

  before(async () => {
    api = await rungApi();
    cli = new CliLog(api);
    d.install();
  });
  after(() => {
    d.uninstall();
    cli.dispose();
  });

  it("starts without a workspace: empty views, no status bar item", async () => {
    assert.equal(api.ws.hasConfig, false);
    assert.deepEqual(await outline(api.project), []);
    assert.deepEqual(await outline(api.plc), []);
    assert.equal(api.statusBar.visible, false);
  });

  it("commands that need a workspace offer to initialize", async () => {
    await vscode.commands.executeCommand("rung.sync");
    assert.deepEqual(d.texts, ["warning: This folder is not a rung workspace (no rung.toml)."]);
    assert.deepEqual(d.of("warning")[0]!.items, ["Open TIA Project…"]);
    assert.equal(cli.runs.length, 0);
  });

  it("Open TIA Project runs rung init --project and the pull without asking, starts watch and fills the views", async () => {
    d.reset();
    d.pickLabel(/^TIA Portal on this PC$/);
    d.open(vscode.Uri.file(process.env.RUNG_E2E_PROJECT!));
    await vscode.commands.executeCommand("rung.init");
    assert.deepEqual(d.of("openDialog").length, 1);
    assert.deepEqual(cli.lines().slice(0, 2), [`init --project ${vscode.Uri.file(process.env.RUNG_E2E_PROJECT!).fsPath}`, "pull"]);
    assert.equal(cli.runs[0]!.result.code, 0, cli.runs[0]!.result.output);
    assert.equal(cli.runs[1]!.result.code, 0, cli.runs[1]!.result.output);
    await waitFor("objects in the Project view", async () => (await outline(api.project)).some((l) => l.startsWith("PLC_1 [7")), 15_000);
    assert.equal(api.ws.hasConfig, true);
    await waitFor("watch started", () => api.watch.status === "running" || api.watch.status === "starting", 30_000);
    assert.match((await outline(api.plc)).join("\n"), /^PLC_1 \[state not checked\]/m);
    await vscode.commands.executeCommand("rung.watch.stop");
  });

  it("the language server works after initializing", async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, "plc", "PLC_1", "blocks", "Fx_Broken.scl");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const pos = doc.positionAt(doc.getText().indexOf("#undeclared") + 2);
    const hovers = await waitFor(
      "hover or diagnostics",
      async () => {
        const diags = vscode.languages.getDiagnostics(uri);
        if (diags.length) return diags;
        const h = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos);
        return h?.length ? h : undefined;
      },
      60_000,
      500,
    );
    assert.ok(hovers.length);
  });
});
