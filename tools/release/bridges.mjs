// SPDX-License-Identifier: MIT
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function installedTiaVersions(programFiles) {
  return ["V20", ...["V19", "V21"].filter(v => existsSync(join(programFiles, "Siemens", "Automation", `Portal ${v}`, "PublicAPI", v, ...(v === "V21" ? ["net48", "Siemens.Engineering.Base.dll"] : ["Siemens.Engineering.dll"]))))];
}

export function stageBridges(root, stage, versions) {
  for (const version of versions) {
    const bin = join(root, "bridge", "src", `Rung.Bridge.${version}`, "bin", "Release", "net48");
    if (!existsSync(join(bin, `rung-bridge-${version.toLowerCase()}.exe`))) throw new Error(`Missing TIA ${version} adapter: ${bin}`);
    for (const file of readdirSync(bin)) if (!file.endsWith(".pdb")) cpSync(join(bin, file), join(stage, "bridge", file));
  }
}
