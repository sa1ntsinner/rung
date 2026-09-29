// SPDX-License-Identifier: MIT
// Integration tests against a real, headless TIA Portal V20 (a workspace mirrored from the fixture project).
// There is no PLC: the fixture's addresses (192.168.254.1, 192.168.253.1) are nobody's, so going online has to
// end with rung's "not found" explanation. Nothing here downloads, and rung.toml is left as it was.
import * as assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RungExtensionApi } from "../../src/extension";
import { CliLog, Dialogs, closeAll, file, findItem, openDoc, outline, positionOf, root, rungApi, waitFor } from "./helpers";

const BROKEN = "plc/PLC_1/blocks/Fx_Broken.scl";
const MOTOR = "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl";
// these need a quiet network: with a VPN to a plant rung rightly offers the devices that answer (fake suite)
const itQuiet = process.env.RUNG_E2E_ANSWERING ? it.skip : it;

describe("rung extension on TIA Portal V20 (headless, no PLC)", function () {
  this.timeout(300_000);
  let api: RungExtensionApi;
  let cli: CliLog;
  let toml: string;
  const d = new Dialogs();

  before(async () => {
    toml = readFileSync(join(root(), "rung.toml"), "utf8");
    api = await rungApi();
    cli = new CliLog(api);
    d.install();
    await api.ws.reload();
  });
  after(async () => {
    d.uninstall();
    cli.dispose();
    await closeAll();
    // never leave a connection behind in the probe workspace
    if (readFileSync(join(root(), "rung.toml"), "utf8") !== toml) writeFileSync(join(root(), "rung.toml"), toml);
  });
  beforeEach(() => {
    d.reset();
    cli.clear();
  });

  it("shows the mirrored TIA project", async () => {
    assert.equal(api.ws.hasConfig, true);
    const text = await waitFor("block types", async () => {
      const t = (await outline(api.project)).join("\n");
      return /Fx_Motor \{[^}]*\} <symbol-class>/.test(t) ? t : undefined;
    });
    assert.match(text, /^PLC_1 \[\d+/m);
    assert.match(text, /^ {2}Program blocks/m);
    assert.match(text, /^ {4}10_Drives /m);
    assert.match(text, /^ {6}Motors /m);
    assert.match(text, /Fx_Secret \[read-only\] \{[^}]*readonly[^}]*\} <lock>/);
    assert.match(text, /^ {2}PLC tags/m);
    assert.match(text, /^ {2}PLC data types/m);
    const { item } = await findItem(api.project, "PLC_1", "Program blocks", "10_Drives", "Motors", "Fx_Motor");
    await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
    await waitFor("Fx_Motor.scl open", () => vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() === file(MOTOR).fsPath.toLowerCase());
  });

  it("CodeLens above the block header", async () => {
    const ed = await openDoc(MOTOR);
    const lenses = await waitFor("CodeLens", async () => {
      const l = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", ed.document.uri);
      return l?.length ? l : undefined;
    });
    assert.deepEqual(lenses.map((l) => l.command?.title), ["Compile", "Test", "Open in TIA Portal"]);
  });

  it("compile this file: TIA Portal's error lands on its line in Problems, without the summary line", async () => {
    const ed = await openDoc(BROKEN);
    await vscode.commands.executeCommand("rung.compileFile");
    const run = cli.find("compile");
    assert.deepEqual(run?.args, ["compile", "--file", BROKEN, "--plc", "PLC_1"]);
    const diags = vscode.languages.getDiagnostics(ed.document.uri).filter((x) => x.source === "TIA Portal");
    assert.deepEqual(
      diags.map((x) => `${x.range.start.line + 1}: ${x.message}`),
      [`${positionOf(ed.document, "#Missing").line + 1}: Tag #Missing not defined.`],
    );
  });

  it("language server: hover and definition", async () => {
    const ed = await openDoc(BROKEN);
    const use = positionOf(ed.document, "#A;", 1);
    const hovers = await waitFor(
      "hover",
      async () => {
        const h = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", ed.document.uri, use);
        return h?.length ? h : undefined;
      },
      60_000,
      500,
    );
    assert.match(hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n"), /Bool/i);
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", ed.document.uri, use);
    const range = "targetRange" in defs[0]! ? defs[0].targetSelectionRange ?? defs[0].targetRange : defs[0]!.range;
    assert.equal(range.start.line, positionOf(ed.document, "A : Bool").line);
  });

  it("online state", async () => {
    await vscode.commands.executeCommand("rung.onlineState");
    assert.deepEqual(d.texts, ["info: Online state: PLC_1: Offline"]);
  });

  itQuiet("go online without a PLC: rung's explanation in a modal, no crash, state shown", async () => {
    d.answer(undefined);
    await vscode.commands.executeCommand("rung.goOnline");
    assert.deepEqual(cli.lines(), ["online --plc PLC_1"]);
    const modal = d.of("warning")[0];
    assert.ok(modal, d.texts.join("\n"));
    assert.equal(modal.modal, true);
    assert.equal(modal.message, "PLC_1 was not found on the network.");
    assert.match(modal.detail!, /The project gives it 192\.168\.254\.1 \(PROFINET interface_1\)/);
    assert.match(modal.detail!, /rung looked on: /);
    assert.match(modal.detail!, /For a simulation, start S7-PLCSIM/);
    assert.equal(api.online.get("PLC_1").error, "not found on the network");
    assert.match((await outline(api.plc)).join("\n"), /^PLC_1 \[state unknown\] \{rung\.plc\} <warning>/m);
  });

  itQuiet("go online, Choose manually: every PG/PC interface of this PC is offered (cancelled)", async () => {
    d.answer("Choose manually");
    let offered: vscode.QuickPickItem[] = [];
    d.pick((items) => {
      offered = [...items];
      return undefined;
    });
    await vscode.commands.executeCommand("rung.goOnline");
    assert.deepEqual(cli.lines(), ["online --plc PLC_1", "interfaces --plc PLC_1"]);
    assert.ok(offered.length >= 2, offered.map((o) => o.label).join(" | "));
    assert.ok(offered.every((o) => /^PN\/IE · 1 X[12]$/.test(o.description ?? "")), offered.map((o) => o.description).join(" | "));
    assert.equal(api.ws.config?.plc.PLC_1, undefined);
  });

  itQuiet("Connect… scans with rung connect --json and explains that nothing answers", async () => {
    d.answer("Retry").answer(undefined);
    await vscode.commands.executeCommand("rung.connect");
    assert.deepEqual(cli.lines(), ["connect --json --plc PLC_1", "connect --json --plc PLC_1"]);
    assert.equal(d.of("warning").length, 2);
    assert.equal(d.of("warning")[1]!.message, "PLC_1 was not found on the network.");
  });

  itQuiet("Interfaces… lists the interfaces (Esc: only look)", async () => {
    let title = "";
    d.pick((items, opts) => {
      title = opts?.title ?? "";
      assert.ok(items.length >= 2);
      return undefined;
    });
    await vscode.commands.executeCommand("rung.interfaces");
    assert.deepEqual(cli.lines(), ["interfaces --scan --plc PLC_1"]);
    assert.match(title, /^Interfaces for PLC_1: no device answered$/);
  });

  itQuiet("download without a PLC stops at the explanation, before any confirmation", async () => {
    d.answer(undefined);
    await vscode.commands.executeCommand("rung.download");
    assert.deepEqual(cli.lines(), ["connect --json --plc PLC_1"]);
    assert.equal(d.of("warning")[0]?.message, "PLC_1 was not found on the network.");
    assert.equal(d.of("inputBox").length, 0);
  });

  it("open in TIA Portal: a headless TIA Portal is explained", async () => {
    await openDoc(MOTOR);
    await vscode.commands.executeCommand("rung.openInTia");
    assert.deepEqual(cli.find("open")?.args, ["open", MOTOR]);
    assert.match(d.texts.join("\n"), /^warning: TIA Portal runs without a user interface on this PC, so it cannot show Fx_Motor/);
  });

  it("status and sync", async () => {
    await vscode.commands.executeCommand("rung.status");
    assert.match(cli.find("status")!.result.output, /\d+ objects/);
  });

  it("watch starts against TIA Portal and stops", async () => {
    await vscode.commands.executeCommand("rung.watch.start");
    await waitFor("rung watch to serve", () => api.ws.watching, 120_000, 500);
    assert.equal(api.watch.status, "running");
    await vscode.commands.executeCommand("rung.status");
    assert.ok(cli.find("status"));
    await vscode.commands.executeCommand("rung.watch.stop");
    await waitFor("watch to stop", () => !api.ws.watching && api.watch.status === "stopped", 60_000);
  });
});
