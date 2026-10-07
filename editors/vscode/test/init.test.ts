// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import type { RungWorkspace } from "../src/workspace";
import type { RungCli } from "../src/runner/cli";

const ui = vi.hoisted(() => ({
  showQuickPick: vi.fn(), showInputBox: vi.fn(), showOpenDialog: vi.fn(),
  showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(),
  executeCommand: vi.fn(), get: vi.fn(),
}));
vi.mock("vscode", () => ({
  window: ui, commands: { executeCommand: ui.executeCommand },
  workspace: { getConfiguration: () => ({ get: ui.get }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));
vi.mock("../src/runner/cli", () => ({ RungCli: { summary: (s: string) => s.trim() } }));
vi.mock("../src/views/environmentView", () => ({ FIXES: { whitelist: { args: ["setup", "openness"], label: "Register bridge" } } }));
import { initCommand } from "../src/commands/init";

const project = "D:\\Projects\\Líne 3\\Líne 3.ap21";
const good = JSON.stringify([
  { id: "tia", group: "plc", name: "TIA Portal", status: "ok", detail: "V21" },
  { id: "openness-group", group: "plc", name: "group", status: "ok" },
  { id: "whitelist", group: "plc", name: "bridge", status: "ok" },
]);

function setup(root: string | undefined = "/mirror") {
  const ws = { root, hasConfig: false, reload: vi.fn(async () => { ws.hasConfig = true; }) };
  const cli = { capture: vi.fn(async () => ({ code: 0, output: good })), run: vi.fn(async () => ({ code: 0, output: "" })) };
  const globalState = { get: vi.fn(() => "previous@pc"), update: vi.fn(async () => {}) };
  const run = () => initCommand(ws as unknown as RungWorkspace, cli as unknown as RungCli, { globalState } as unknown as ExtensionContext);
  return { ws, cli, globalState, run };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RUNG_BRIDGE", "fake-bridge");
  vi.stubGlobal("process", { ...process, platform: "linux" });
  ui.showQuickPick.mockResolvedValue("TIA Portal on another PC (ssh)…");
  ui.showInputBox.mockResolvedValueOnce("engineer@tia-pc").mockResolvedValueOnce(project);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Open TIA Project", () => {
  it("checks the remote PC, preserves the literal path, pulls and starts watch", async () => {
    const t = setup();
    await t.run();
    expect(t.cli.capture.mock.calls[0]?.[0]).toEqual(["check", "--host", "engineer@tia-pc", "--json"]);
    expect(t.cli.run.mock.calls.map((c) => c[0])).toEqual([["init", "--project", project, "--host", "engineer@tia-pc"], ["pull"]]);
    expect(ui.showOpenDialog).not.toHaveBeenCalled();
    expect(t.globalState.update).toHaveBeenCalledWith("rung.remote.host", "engineer@tia-pc");
    expect(ui.showInputBox.mock.calls[0]?.[0].value).toBe("previous@pc");
    expect(ui.executeCommand).toHaveBeenCalledWith("rung.watch.start");
  });

  it("uses the configured remote host as the input default", async () => {
    ui.get.mockReturnValue("configured@pc");
    const t = setup();
    await t.run();
    expect(ui.showInputBox.mock.calls[0]?.[0].value).toBe("configured@pc");
    expect(ui.showQuickPick).not.toHaveBeenCalled();
  });

  it("asks for a local mirror folder without treating the remote project path as a local default", async () => {
    const t = setup();
    t.ws.root = undefined;
    ui.showOpenDialog.mockResolvedValue([{ fsPath: "/chosen-mirror" }]);
    await t.run();
    expect(ui.showOpenDialog.mock.calls[0]?.[0]).toMatchObject({ canSelectFolders: true });
    expect(ui.showOpenDialog.mock.calls[0]?.[0].defaultUri).toBeUndefined();
    expect(t.cli.run.mock.calls.map((c) => c[0])).toEqual([["init", "/chosen-mirror", "--project", project, "--host", "engineer@tia-pc"], ["pull", "/chosen-mirror"]]);
    expect(ui.executeCommand).toHaveBeenCalledWith("vscode.openFolder", { fsPath: "/chosen-mirror" });
  });

  it("stops when the remote check fails instead of opening TIA without a preflight", async () => {
    const t = setup();
    t.cli.capture.mockResolvedValue({ code: 1, output: "CHECK_UNREACHABLE" });
    await t.run();
    expect(t.cli.run).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenCalled();
  });

  it("uses the remote answer to reject a missing project version", async () => {
    const t = setup();
    t.cli.capture.mockResolvedValue({ code: 0, output: good.replace("V21", "V20") });
    await t.run();
    expect(t.cli.run).not.toHaveBeenCalled();
    expect(ui.showErrorMessage.mock.calls[0]?.[0]).toContain("V21");
  });

  it("keeps remote whitelist registration on the remote PC", async () => {
    const t = setup();
    t.cli.capture.mockResolvedValue({ code: 0, output: good.replace('"name":"bridge","status":"ok"', '"name":"bridge","status":"warn"') });
    ui.showWarningMessage.mockResolvedValue("Go On");
    await t.run();
    expect(ui.showWarningMessage.mock.calls[0]?.[0]).toContain("rung setup openness");
    expect(ui.showWarningMessage.mock.calls[0]?.[0]).toContain("engineer@tia-pc");
    expect(t.cli.run.mock.calls.map((c) => c[0])).toEqual([["init", "--project", project, "--host", "engineer@tia-pc"], ["pull"]]);
  });

  it.each(["choice", "host", "project"])("cancelling the %s runs no commands", async (step) => {
    if (step === "choice") ui.showQuickPick.mockResolvedValue(undefined);
    else {
      ui.showInputBox.mockReset();
      if (step === "project") ui.showInputBox.mockResolvedValueOnce("engineer@tia-pc");
      ui.showInputBox.mockResolvedValueOnce(undefined);
    }
    const t = setup();
    await t.run();
    expect(t.cli.capture).not.toHaveBeenCalled();
    expect(t.cli.run).not.toHaveBeenCalled();
  });

  it("keeps the local file dialog and init arguments", async () => {
    ui.showQuickPick.mockResolvedValue("TIA Portal on this PC");
    ui.showOpenDialog.mockResolvedValue([{ fsPath: "C:\\Work\\Line.ap20" }]);
    const t = setup();
    await t.run();
    expect(ui.showInputBox).not.toHaveBeenCalled();
    expect(t.cli.capture).not.toHaveBeenCalled();
    expect(t.cli.run.mock.calls.map((c) => c[0])).toEqual([["init", "--project", "C:\\Work\\Line.ap20"], ["pull"]]);
    expect(ui.executeCommand).toHaveBeenCalledWith("rung.watch.start");
  });
});
