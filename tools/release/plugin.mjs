// SPDX-License-Identifier: MIT
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A cached marketplace plugin must keep both its CLI and the release's version.
export function stagePlugin(root, stage, version) {
  const plugin = join(stage, "agents", "claude-plugin");
  cpSync(join(root, "agents", "claude-plugin"), plugin, { recursive: true });
  cpSync(join(root, "agents", ".claude-plugin"), join(stage, "agents", ".claude-plugin"), { recursive: true });
  const manifestPath = join(plugin, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const runtime = join(plugin, "bin", "runtime");
  for (const name of ["rung.cjs", "bridge", "source", "LICENSES", "tools", "LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "AGENTS.template.md"]) {
    cpSync(join(stage, name), join(runtime, name), { recursive: true });
  }
}
