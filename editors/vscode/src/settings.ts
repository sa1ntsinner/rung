// SPDX-License-Identifier: MIT
// Typed access to the rung.* settings (contributes.configuration in package.json).
import * as vscode from "vscode";
import type { HardwareChoice } from "./core/args";

export type Verbosity = "quiet" | "normal" | "verbose";

export interface Settings {
  command: string[];
  autoStartWatch: boolean;
  statusBar: boolean;
  codeLens: boolean;
  compileOnSave: boolean;
  /** Seconds; 0 = off. */
  onlineRefresh: number;
  reuseTerminal: boolean;
  verbosity: Verbosity;
  download: {
    confirmation: "typeName" | "modal";
    pickOptions: boolean;
    hardware: HardwareChoice;
    allBlocks: boolean;
    startAfter: boolean;
    allow: string[];
  };
  projectView: { grouping: "folder" | "kind"; showReadOnly: boolean };
}

/** Lowest online-state refresh interval; faster would keep TIA Portal busy. */
export const MIN_ONLINE_REFRESH_S = 5;

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("rung");
  const raw = c.get<string[] | string>("command") ?? ["rung"];
  const command = (Array.isArray(raw) ? raw : raw.trim() ? [raw.trim()] : []).filter((s) => typeof s === "string" && s.length);
  const refresh = Math.max(0, c.get<number>("online.refreshInterval") ?? 0);
  return {
    command: command.length ? command : ["rung"],
    autoStartWatch: c.get<boolean>("watch.autoStart") ?? true,
    statusBar: c.get<boolean>("statusBar.enabled") ?? true,
    codeLens: c.get<boolean>("codeLens.enabled") ?? true,
    compileOnSave: c.get<boolean>("compileOnSave") ?? false,
    onlineRefresh: refresh === 0 ? 0 : Math.max(MIN_ONLINE_REFRESH_S, refresh),
    reuseTerminal: c.get<boolean>("terminal.reuse") ?? true,
    verbosity: c.get<Verbosity>("output.verbosity") ?? "normal",
    download: {
      confirmation: c.get<"typeName" | "modal">("download.confirmation") === "modal" ? "modal" : "typeName",
      pickOptions: c.get<boolean>("download.pickOptions") ?? true,
      hardware: c.get<HardwareChoice>("download.hardware") ?? "rungToml",
      allBlocks: c.get<boolean>("download.allBlocks") ?? false,
      startAfter: c.get<boolean>("download.startAfter") ?? true,
      allow: c.get<string[]>("download.allow") ?? [],
    },
    projectView: {
      grouping: c.get<"folder" | "kind">("projectView.grouping") === "kind" ? "kind" : "folder",
      showReadOnly: c.get<boolean>("projectView.showReadOnly") ?? true,
    },
  };
}
