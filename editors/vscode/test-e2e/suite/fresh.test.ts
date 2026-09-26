// SPDX-License-Identifier: MIT
// First run: a folder without rung.toml. Initialize from a TIA Portal project, pull, and the views fill.
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
    assert.deepEqual(d.of("warning")[0]!.items, ["Initialize…"]);
    assert.equal(cli.runs.length, 0);
  });

  it("Initialize runs rung init --project, then offers the pull and fills the views", async () => {
    d.reset();
    d.open(vscode.Uri.file(process.env.RUNG_E2E_PROJECT!)).answer("Pull");
    await vscode.commands.executeCommand("rung.init");
    assert.deepEqual(d.of("openDialog").length, 1);
    assert.deepEqual(cli.lines(), [`init --project ${vscode.Uri.file(process.env.RUNG_E2E_PROJECT!).fsPath}`, "pull"]);
    assert.equal(cli.runs[0]!.result.code, 0, cli.runs[0]!.result.output);
    assert.equal(cli.runs[1]!.result.code, 0, cli.runs[1]!.result.output);
    await waitFor("objects in the Project view", async () => (await outline(api.project)).some((l) => l.startsWith("PLC_1 [7")), 15_000);
    assert.equal(api.ws.hasConfig, true);
    await waitFor("status bar", () => api.statusBar.visible && api.statusBar.text === "$(circle-slash) rung: idle");
    assert.match((await outline(api.plc)).join("\n"), /^PLC_1 \[state not checked\]/m);
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
