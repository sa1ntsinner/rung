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
  filter: "a part of a test file's path (any letter case) or a block name", writes: "turn writes to TIA Portal on (rung writes off stops them)",
  ours: "keep your file", theirs: "take TIA Portal's version", merged: "use the file you merged; remove its conflict markers first",
  force: "pull: replace local edits (each kept in .rung/recovery); confirm-delete: delete although other blocks use it",
  dir: "the workspace (default: the current folder)", file: "a workspace file", project: "the TIA Portal project (.ap20)",
  tia: "TIA Portal version (V20, V21)", device: "mirror only this PLC (repeat for more)", rebind: "bind the folder to another project",
  plc: "the PLC (when the project has several)", pick: "choose among the connections that answer", use: "the PG/PC interface (rung interfaces lists them)",
  mode: "PN/IE, PROFIBUS, …", number: "the interface number", target: "the PLC's interface, e.g. 1 X1", scan: "also look for reachable devices",
  state: "only say whether the PLC is online", hw: "download the hardware configuration too", "no-hw": "software only",
  "no-sw": "hardware only", "all-blocks": "download every block, not only the changed ones", allow: "a TIA question download may answer yes (e.g. stop-cpu, reset-module)",
  "no-start": "leave the CPU stopped afterwards", yes: "skip the typed confirmation (scripts; never for agents)",
  junit: "write a JUnit report (CI)", "dry-run": "say what would change, change nothing", scope: "project (this folder) or global (your user)",
  agents: "claude, codex, cursor, gemini, opencode, copilot, zed", editors: "vscode, zed, neovim", skills: "which PLC engineering skills to copy",
  platforms: "tia, twincat, codesys", offline: "from the files only, no TIA Portal", fixture: "against the generated test fixture project",
  grant: "let your user update the whitelist later without administrator rights", stdio: "speak LSP on stdin/stdout",
  block: "the FB or FC to run", cycle: "cycle time in ms", address: "address to listen on", port: "port to listen on",
  instance: "the instance DB to read an FB through", interval: "how often to read, in ms", ip: "the PLC's address",
  "from-plc": "make a new project from the PLC at this address", host: "run the bridge on a Windows PC over ssh", off: "turn it off",
};
/** What the exit code means, for the commands scripts and CI read it from. */
const EXIT: Record<string, string> = {
  sync: "0 done (also with writes off and edits waiting), 1 rung could not run, 2 needs attention: a conflict, a refused import or a compile error",
  watch: "1 rung could not start; otherwise runs until Ctrl+C",
  status: "0 nothing open, 2 a conflict or a compile error stands",
  compile: "0 compiled without errors, 1 rung could not run, 2 TIA Portal reported errors",
  test: "0 all passed, 1 rung could not run, 2 a case failed, 3 no tests matched",
  compare: "0 the PLC runs what the project has, 2 they differ",
  assignments: "0 no overlapping accesses, 2 two accesses overlap",
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
  return `Usage:\n${usage.join("\n")}\n\nOptions:\n${[...flags, "  -h, --help  show this usage"].join("\n")}\n\nExample:\n  rung ${EXAMPLES[cmd] ?? cmd}\n${EXIT[cmd] ? `\nExit code: ${EXIT[cmd]}\n` : ""}`;
}
