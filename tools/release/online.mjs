// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const walk = dir => readdirSync(dir).flatMap(name => {
  const file = join(dir, name), info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error(`Release source must not contain links: ${file}`);
  return info.isDirectory() ? walk(file) : [file];
});
export function stageOnline(root, stage, publish) {
  for (const file of readdirSync(publish)) if (!file.endsWith(".pdb")) cpSync(join(publish, file), join(stage, "bridge", file));
  const upstream = join(root, "third_party", "S7CommPlusDriver");
  const source = join(stage, "source", "S7CommPlusDriver"); mkdirSync(source, { recursive: true });
  for (const file of ["LICENSE", "RUNG-CHANGES.md", "global.json"]) cpSync(join(upstream, file), join(source, file));
  cpSync(join(upstream, "src", "S7CommPlusDriver"), join(source, "src", "S7CommPlusDriver"), { recursive: true,
    filter: path => !relative(join(upstream, "src", "S7CommPlusDriver"), path).split(/[\\/]/).some(part => ["bin", "obj", "runtimes"].includes(part)) && !/\.(dll|exe|so|dylib|pdb|nupkg)$/i.test(path) });
  cpSync(join(root, "tools", "online", "REPLACEMENT.md"), join(source, "REPLACEMENT.md"));
  writeFileSync(join(source, "MANIFEST.json"), JSON.stringify({ upstream: "5c84e77", driverSha256: sha(join(stage, "bridge", "S7CommPlusDriver.dll")),
    files: Object.fromEntries(walk(source).map(file => [relative(source, file).split(sep).join("/"), sha(file)])) }, null, 2) + "\n");
}
export function auditOnlineRelease(stage) {
  const forbidden = walk(stage).filter(file => /(?:siemens|harpos7).*\.(?:dll|exe|so|dylib|nupkg)$/i.test(relative(stage, file)));
  if (forbidden.length) throw new Error(`Forbidden release binaries: ${forbidden.join(", ")}`);
  for (const name of ["LGPL-3.0.txt", "GPL-3.0.txt", "BouncyCastle-MIT.txt", "zlib.net-BSD-3-Clause.txt", "Microsoft.NET-MIT.txt", "Microsoft.NET-NOTICES.txt"])
    if (!existsSync(join(stage, "LICENSES", name)) || readFileSync(join(stage, "LICENSES", name), "utf8").length < 500) throw new Error(`Missing release license: ${name}`);
  if (!existsSync(join(stage, "bridge", "rung-online.exe"))) throw new Error("Missing standalone online host");
  const source = resolve(stage, "source", "S7CommPlusDriver"), manifest = JSON.parse(readFileSync(join(source, "MANIFEST.json"), "utf8"));
  if (manifest.driverSha256 !== sha(join(stage, "bridge", "S7CommPlusDriver.dll"))) throw new Error("Driver binary differs from corresponding-source manifest");
  const files = Object.entries(manifest.files ?? {});
  if (!files.length || !files.some(([name]) => name.endsWith("S7CommPlusDriver.csproj"))) throw new Error("Missing corresponding driver source project");
  for (const [name, hash] of files) {
    const file = resolve(source, name);
    if (!file.startsWith(source + sep) || sha(file) !== hash) throw new Error(`Corresponding driver source differs: ${name}`);
  }
  if (walk(source).length !== files.length + 1) throw new Error("Unlisted corresponding driver source files");
  return { sourceFiles: files.length, driverSha256: manifest.driverSha256 };
}
