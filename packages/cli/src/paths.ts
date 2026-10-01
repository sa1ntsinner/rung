// SPDX-License-Identifier: BUSL-1.1
// Where rung finds its companion files: environment override, the installed layout next to rung.exe,
// or the source tree during development.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder of an installed rung (rung.exe single executable or bundled rung.cjs), if any. */
export function installRoot(env: Record<string, string | undefined> = process.env, argv1 = process.argv[1]): string | undefined {
  if (env.RUNG_HOME) return env.RUNG_HOME;
  const exe = basename(process.execPath).toLowerCase();
  // VS Code's executable running rung.cjs as Node.js (the extension's rung) is not a single executable application
  if (exe !== "node.exe" && exe !== "node" && !process.versions.electron) return dirname(process.execPath); // single executable application
  // npm on Linux and macOS starts rung.cjs through a link named rung in its bin folder
  const script = argv1 && realpathOr(argv1);
  if (script && /rung\.c?js$/i.test(script)) return dirname(script);
  return undefined;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function devPath(rel: string): string | undefined {
  try {
    return fileURLToPath(new URL(rel, import.meta.url));
  } catch {
    return undefined; // bundled build: import.meta.url is not available
  }
}

export function bridgeExecutable(env: Record<string, string | undefined>, tia: "V20" | "V21" = "V20"): string {
  const name = `rung-bridge-${tia.toLowerCase()}.exe`;
  const root = installRoot(env);
  const candidates = [
    root && join(root, "bridge", name),
    devPath(`../../../bridge/src/Rung.Bridge.${tia}/bin/Release/net48/${name}`),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? candidates[0] ?? name;
}

export function agentsTemplatePath(env: Record<string, string | undefined> = process.env): string | undefined {
  const root = installRoot(env);
  return [root && join(root, "AGENTS.template.md"), devPath("../../../agents/AGENTS.template.md")].find((p): p is string => !!p && existsSync(p));
}
