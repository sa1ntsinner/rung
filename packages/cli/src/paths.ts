// SPDX-License-Identifier: BUSL-1.1
// Where rung finds its companion files: environment override, the installed layout next to rung.exe,
// or the source tree during development.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder of an installed rung (rung.exe single executable or bundled rung.cjs), if any. */
export function installRoot(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.RUNG_HOME) return env.RUNG_HOME;
  const exe = basename(process.execPath).toLowerCase();
  if (exe !== "node.exe" && exe !== "node") return dirname(process.execPath); // single executable application
  const script = process.argv[1];
  if (script && /rung\.c?js$/i.test(script)) return dirname(script);
  return undefined;
}

function devPath(rel: string): string | undefined {
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
