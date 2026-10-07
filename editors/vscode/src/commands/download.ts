// SPDX-License-Identifier: MIT
// Download to a PLC (docs/downloads.md): a person starts it, sees what goes where in a
// modal, types the PLC name (setting), and watches TIA's questions and rung's answers in a terminal.
// Nothing else in the extension downloads: no CodeLens, no save hook.
import * as vscode from "vscode";
import { ALLOW_NAMES, describeDownload, downloadArgs, parseNeedsAllow, parseRefused, type DownloadOptions } from "../core/args";
import { DOWNLOAD_DEFAULTS } from "../core/rungToml";
import type { OnlineMonitor } from "../online";
import { RungCli } from "../runner/cli";
import { readSettings } from "../settings";
import type { RungWorkspace } from "../workspace";
import type { Connector } from "./connect";
import { deviceTarget } from "./targets";

let inProgress = false;

async function confirmTyped(device: string, retry: boolean): Promise<boolean> {
  if (readSettings().download.confirmation !== "typeName") return true;
  const typed = await vscode.window.showInputBox({
    title: retry ? `Retry download to ${device}` : `Download to ${device}`,
    prompt: `Type the PLC name ${device} to confirm the download`,
    placeHolder: device,
    ignoreFocusOut: true,
    validateInput: (v) => (v === device || v === "" ? undefined : `Type exactly ${device}`),
  });
  return typed === device;
}

async function pickOptions(o: DownloadOptions, tomlHardware: boolean): Promise<DownloadOptions | undefined> {
  type Item = vscode.QuickPickItem & { key: "software" | "hardware" | "allBlocks" | "startAfter" };
  const hwOn = o.hardware === "include" || (o.hardware === "rungToml" && tomlHardware);
  const items: Item[] = [
    { key: "software", label: "Software", description: "program blocks, tags, types", picked: o.software },
    { key: "hardware", label: "Hardware configuration", description: tomlHardware ? "rung.toml: on" : "rung.toml: off", picked: hwOn },
    { key: "allBlocks", label: "All blocks", description: "not only changed ones", picked: o.allBlocks },
    { key: "startAfter", label: "Start the CPU afterwards", description: "if the download stopped it", picked: o.startAfter },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: `Download to ${o.device}: what to download`, canPickMany: true, ignoreFocusOut: true, placeHolder: "Space toggles, Enter continues" });
  if (!picked) return undefined;
  const has = (k: Item["key"]) => picked.some((p) => p.key === k);
  const hardware = has("hardware") === tomlHardware && o.hardware === "rungToml" ? "rungToml" : has("hardware") ? "include" : "exclude";
  const next: DownloadOptions = { ...o, software: has("software"), hardware, allBlocks: has("allBlocks"), startAfter: has("startAfter") };
  if (!next.software && next.hardware !== "include" && !(next.hardware === "rungToml" && tomlHardware)) {
    void vscode.window.showWarningMessage("Nothing selected: pick software, hardware or both.");
    return undefined;
  }
  return next;
}

export async function downloadCommand(ws: RungWorkspace, cli: RungCli, online: OnlineMonitor, connector: Connector, arg: unknown): Promise<void> {
  if (inProgress) {
    void vscode.window.showWarningMessage("A download is already running. Wait for it to finish.");
    return;
  }
  if (!ws.hasConfig) {
    void vscode.window.showWarningMessage("This folder has no rung.toml.");
    return;
  }
  const toml = ws.config?.download ?? DOWNLOAD_DEFAULTS;
  if (!toml.enabled) {
    void vscode.window.showWarningMessage("Downloads are turned off for this workspace (download.enabled = false in rung.toml).");
    return;
  }
  const device = await deviceTarget(ws, arg, "Download");
  if (!device) return;
  // rung download would look for the PLC itself; do it first so the confirmation names the connection
  if (!(await connector.ensure(device))) return;
  const conn = ws.config?.plc[device];
  if (!conn) return;
  const s = readSettings().download;
  let options: DownloadOptions = { device, hardware: s.hardware, software: true, allBlocks: s.allBlocks, startAfter: s.startAfter, allow: s.allow };
  if (s.pickOptions) {
    const picked = await pickOptions(options, toml.hardware);
    if (!picked) return;
    options = picked;
  }

  const plan = describeDownload(options, toml, conn);
  const go = await vscode.window.showWarningMessage(plan.message, { modal: true, detail: plan.detail }, "Download");
  if (go !== "Download" || !(await confirmTyped(device, false))) return;

  inProgress = true;
  await vscode.commands.executeCommand("setContext", "rung.downloading", true);
  try {
    for (;;) {
      let args: string[];
      try {
        args = downloadArgs(options);
      } catch (e) {
        void vscode.window.showErrorMessage((e as Error).message);
        return;
      }
      const r = await cli.run(args, {
        terminal: `rung download ${device}`,
        icon: "desktop-download",
        guardInterrupt: "Stopping rung does not stop a download TIA Portal has already started. Press Ctrl+C again to stop rung anyway.",
      });
      void online.refresh(device);
      if (r.error) return;
      if (r.code === 0) {
        void vscode.window.showInformationMessage(`Download to ${device} finished.`);
        return;
      }
      // what is said about the PLC follows what rung knows (the CLI's exit code carries the phase), never a guess
      const check = async (message: string) => {
        const pick = await vscode.window.showWarningMessage(message, "Compare with PLC", "Online State");
        if (pick === "Compare with PLC") await vscode.commands.executeCommand("rung.compare", device);
        if (pick === "Online State") await vscode.commands.executeCommand("rung.onlineState", device);
      };
      if (r.code === 4) {
        await check(`The download reached ${device}, but TIA Portal asked something afterwards that rung did not answer: ${device} may be in STOP.`);
        return;
      }
      if (r.code === 5) {
        await check(`rung lost track of the download to ${device} (see the terminal). It may have run in part or in full.`);
        return;
      }
      if (r.code === 2 && /The transfer had started/.test(r.output)) {
        await check(`Download to ${device} failed after the transfer had started: ${device} may hold part of it.`);
        return;
      }
      if (r.code !== 3) {
        const why = RungCli.summary(r.output);
        void vscode.window.showErrorMessage(
          r.code === 1 ? `Nothing was downloaded to ${device}${why ? `: ${why}` : "."}` : /compile errors/.test(r.output) ? `Nothing was downloaded to ${device}: the program has compile errors (see Problems and the terminal).` : `Download to ${device} failed before the transfer (exit code ${r.code}). See the terminal.`,
        );
        return;
      }
      // TIA asked questions the policy answers with "no": offer to repeat with exactly those allowed.
      const needs = parseNeedsAllow(r.output);
      if (!needs.length) {
        void vscode.window.showWarningMessage(`TIA Portal cancelled the download to ${device}. See the terminal.`);
        return;
      }
      const refused = parseRefused(r.output);
      const lines = needs.map((n) => {
        const msg = refused.find((q) => q.name === n)?.message;
        return `• ${n}: ${ALLOW_NAMES[n] ?? "see terminal"}${msg ? `\n   TIA: ${msg}` : ""}`;
      });
      const label = `Retry allowing ${needs.join(", ")}`;
      const retry = await vscode.window.showWarningMessage(
        `TIA Portal cancelled the download to ${device}. Retry allowing ${needs.join(", ")}?`,
        {
          modal: true,
          detail: `Nothing was downloaded. TIA Portal asked to:\n${lines.join("\n")}\n\nRetrying answers "yes" to these questions only, once. To allow them always, add them to [download].allow in rung.toml.`,
        },
        label,
      );
      if (retry !== label || !(await confirmTyped(device, true))) return;
      options = { ...options, allow: [...options.allow, ...needs] };
    }
  } finally {
    inProgress = false;
    await vscode.commands.executeCommand("setContext", "rung.downloading", false);
  }
}
