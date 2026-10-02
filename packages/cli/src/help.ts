// SPDX-License-Identifier: BUSL-1.1
// Command help uses the same usage lines and option list as argument validation.
const EXAMPLES: Record<string, string> = {
  setup: "setup --dry-run", check: "check --json", init: "init --project Line.ap20",
  writes: "writes off", backup: "backup", pull: "pull", sync: "sync --preview", watch: "watch", status: "status",
  resolve: "resolve plc/PLC_1/blocks/Valve.scl --merged", "confirm-delete": "confirm-delete plc/PLC_1/blocks/Valve.scl",
  rename: "rename plc/PLC_1/blocks/Valve.scl ValveCtl", test: "test --filter Valve", live: "live read StartButton",
  views: "views --offline", agents: "agents", mcp: "mcp", lsp: "lsp --stdio", doctor: "doctor --fixture",
  compile: "compile --file plc/PLC_1/blocks/Valve.scl", online: "online --state", compare: "compare --json",
  connect: "connect --pick", interfaces: "interfaces --scan", download: "download --plc PLC_1", open: "open plc/PLC_1/blocks/Valve.scl",
  simulate: "simulate --block Valve", "codesys-bridge": "codesys-bridge --project Line.project", assignments: "assignments --json",
  who: "who StartButton", upload: "upload --ip 192.168.0.1",
  bridge: "bridge --tia V20",
};
const VALUES: Record<string, string> = {
  project: "file", tia: "version", device: "name", dir: "workspace", junit: "file", filter: "text", file: "file", plc: "name",
  allow: "answer", agents: "names", skills: "names", editors: "names", platforms: "names", scope: "project|global",
  address: "ip", port: "number", cycle: "ms", block: "name", use: "PG/PC interface", mode: "mode", number: "n", target: "interface",
  instance: "DB", interval: "ms", ip: "address", "from-plc": "ip", host: "user@windows-pc",
  args: "encoded arguments",
};
const DETAIL: Record<string, string> = {
  preview: "show the next sync without changing files or TIA Portal", json: "complete machine-readable report",
  filter: "test path substring or exact block name", writes: "turn writes to TIA Portal on (rung writes off stops them)",
  ours: "keep your file", theirs: "take TIA Portal's version", merged: "use the file you merged; remove its conflict markers first",
};

export function commandHelp(cmd: string, options: readonly string[], help: string): string {
  const rows = help.split("\n");
  const usage: string[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i]!.startsWith(`  rung ${cmd} `) || rows[i] === `  rung ${cmd}`) {
    usage.push(rows[i]!);
    while (rows[i + 1]?.startsWith("             ")) usage.push(rows[++i]!);
  }
  if (!usage.length) usage.push(`  rung ${cmd}${cmd === "codesys-bridge" ? " --project <file.project>" : ""}`);
  const flags = options.map((o) => `  --${o}${VALUES[o] ? ` <${VALUES[o]}>` : ""}${DETAIL[o] ? `  ${DETAIL[o]}` : ""}`);
  return `Usage:\n${usage.join("\n")}\n\nOptions:\n${[...flags, "  -h, --help  show this usage"].join("\n")}\n\nExample:\n  rung ${EXAMPLES[cmd] ?? cmd}\n`;
}
