// SPDX-License-Identifier: MIT
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import { Dialogs, root, rungApi, waitFor } from "./helpers";

describe("behaviour discovery workbench", function () {
  this.timeout(60_000);
  const dialogs = new Dialogs();
  before(() => dialogs.install());
  after(() => dialogs.uninstall());

  it("finds an unwritten source regression, opens the workbench, and exports a failing regression test", async () => {
    const api = await rungApi(), folder = root();
    await api.ws.reload();
    const blocks = join(folder, "plc/PLC_1/blocks"), file = join(blocks, "DiscoveryMotor.scl");
    mkdirSync(blocks, { recursive: true });
    const source = 'FUNCTION_BLOCK "DiscoveryMotor"\nVAR_INPUT\n Start : Bool;\n Permit : Bool;\nEND_VAR\nVAR_OUTPUT\n Running : Bool;\nEND_VAR\nBEGIN\n #Running := (#Running OR #Start) AND #Permit;\nEND_FUNCTION_BLOCK\n';
    writeFileSync(file, source);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], { cwd: folder, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q"); git("add", "."); git("commit", "-qm", "reference");
    writeFileSync(file, source.replace("(#Running OR #Start) AND #Permit", "#Running OR (#Start AND #Permit)"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    await vscode.commands.executeCommand("rung.discoverBehaviour");
    const workbench = await waitFor("Discovery tab: " + dialogs.texts.join("\n"), () => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === "Discovery: DiscoveryMotor"));
    const output = join(folder, ".rung/discover");
    const directory = join(output, readdirSync(output)[0]!);
    const evidence = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"));
    assert.equal(evidence.status, "found");
    assert.equal(evidence.witness.difference.signal, "Running");
    assert.equal(evidence.witness.difference.cycle, 2);
    const tests = join(folder, "tests/PLC_1"); mkdirSync(tests, { recursive: true });
    writeFileSync(join(tests, "discovered.test.yaml"), evidence.referenceTest);
    const result = await api.cli.capture(["test", "--case", "tests/PLC_1/discovered.test.yaml#0"], { quiet: true });
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /Running/);
    await vscode.window.tabGroups.close(workbench);
  });
});
