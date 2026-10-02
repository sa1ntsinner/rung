# Editor setup

All editors use the same language server: `rung lsp --stdio` (run from the workspace folder, the one with `rung.toml`). It works offline on any OS; with `rung watch` running it also shows TIA Portal compile errors and sync conflicts, and what the watch is doing while it does it ("sending Fx_Motor.scl to TIA Portal", "compiling …") as the editor's progress, in VS Code, Zed and Neovim alike. Neovim finds it as `rung` on PATH: the release folder, `npm install -g @rung-plc/cli` (Node.js 22+, also on Linux and macOS) or VS Code's **rung: Put rung on PATH**. VS Code and Zed bring their own when there is none.

What it does in every editor: completion (locals, DB and UDT members, instructions; full call templates when the editor supports snippets), signature help inside calls (parameter types and directions, with the current argument selected), read/write highlights of a name's uses in the file, go to definition and references across files (also from a type in a declaration and from a call's named argument), rename (a variable in the editor: a block's parameter or static, a DB's or a data type's member also in the calls, instances and DB start values that name it; a block, data type or DB in TIA Portal, like `rung rename`, so every use there and in your files follows), the block outline, finding any block, data type, DB or tag of the project by name (VS Code `Ctrl+T`, Zed `project symbols`, Neovim `vim.lsp.buf.workspace_symbol()`), folding of REGIONs, VAR sections, statements and comments, errors while typing (a missing `;`, a CASE label taken twice, text into a number, a misspelt member with the name it meant), help on hover (an instruction's parameters, a data type's size and range, a PLC data type's members) and quick fixes like TIA Portal's: declare an undeclared `#tag` as a temporary or a static, define an unknown `"tag"` as a PLC tag (a line in the tag table at the next free bit memory), give an FB called without an instance a new instance DB or a multi-instance, and update a block call after its interface changed (rename an argument to the parameter it most likely was, remove stale arguments, add the FC parameters it leaves out). In a tag table (`.tags.st`) it flags what TIA Portal's import would refuse: a tag without an address or with a type that does not fit it, two tags on one line, a name used twice, a start value on a tag.

## VS Code (and Cursor, Windsurf, VSCodium)

Build and install the extension from `editors/vscode`:

```
npm install
npm run package
code --install-extension rung-scl.vsix
```

If `rung` is not on PATH, set in settings:

```json
"rung.command": ["node", "C:/path/to/rung/packages/cli/dist/index.js"]
```

The extension runs the rung CLI for everything; it only reads `rung.toml` and `.rung/state.json` itself.

- **rung sidebar** (activity bar): *Project* lists the mirrored objects by PLC, kind and TIA folder (or by block type) with conflict, changed and read-only marks; right-click to compile, test, open in TIA Portal or resolve a conflict. *PLC* shows whether `rung watch` runs (start/stop), whether this workspace may write into the project (*Writes to TIA Portal*: off after initializing, click to turn on; `rung writes on`), each PLC's online state and connection, and Go online, Go offline, Compile PLC, Compile hardware, Interfaces…, Download…. A folder without `rung.toml` gets *Initialize from a TIA Portal project* (`rung init --project`).
- **Who Writes This?** (`Alt+Q U`, or right-click a name): what writes the tag, DB member or variable under the cursor across the project, each with its block and line and the call of that block, then what reads it. A DB member is that DB's own (`"Plant_DB".Pump.Running`, not every motor's Running), followed into the blocks the structure holding it is handed to (`Data := "Plant_DB".Pump` → `#Data.Running` in FB_Motor). HMI, communication blocks and indirect access are not seen, and the list says so. In a terminal or Zed: `rung who "Line_DB".Speed` (Zed task *who writes the selected name*).
- **Preview Sync** (`Alt+Q Shift+S`, also in the actions list): what the next sync would send to TIA Portal and bring into the files, each as a diff of the side it lands on, before anything is written; then *Sync now* or, while writes are off, *Turn on writes*.
- **Status bar**: watching / idle / conflicts / online PLCs; click for all actions.
- **CodeLens** above every block header and editor title buttons: Compile, Test, Open in TIA Portal. Compile messages land in Problems.
- **Testing view**: every `tests/**/*.test.yaml` and each of its cases, run on the offline simulator from there or from the ▶ next to a case. A failed expectation shows on the line of its step with the expected and the actual value side by side; a block the simulator refuses says why on the case.
- **Monitor Values** (the eye in the editor title, `alt+q v`): like TIA Portal's *Monitoring on*, the values of the open block appear at the end of each line, read twice a second from the PLC's Web API by `rung live watch` (read-only). An FB is read through its instance DB; with several, you pick one (or type a multi-instance such as `"Line_DB".Motor1`). It needs `[live.webapi]` in `rung.toml`; the password is asked once and kept in VS Code's secret storage. Editing the block stops monitoring, as in TIA Portal. Without hardware, `rung simulate` is the PLC.
- **Environment** view: what `rung check` finds on this PC, with a fix for what rung can set up itself and links for the rest; *Set Up Editors and Agents…* runs `rung setup`.
- **Go online** needs no setup: `rung online` finds the PLC by its project addresses and saves `[plc.<name>]` in `rung.toml`. When several interfaces reach it, a list lets you choose (saved with `rung connect --use …`, then the action runs again). When nothing answers, a dialog shows rung's explanation with *Retry*, *Choose manually* (all PG/PC interfaces from `rung interfaces`) and *Show details*.
- **Connect…** (`rung connect --json`) looks again and lets you change the connection; **Interfaces…** runs `rung interfaces --scan` and saves the interface you pick (Esc only looks). The extension never edits `rung.toml` itself; rung does.
- **Download…** first asks you to choose the connection if none is saved (it never picks one by itself), then shows a warning dialog with the PLC, the connection and what is downloaded, asks you to type the PLC name, then runs `rung download --yes` in its own terminal so you see every TIA question and answer. If TIA cancels (for example it wants to stop the CPU), it offers a retry that allows exactly that, with the same confirmation. It never downloads from CodeLens or on save.
- **Commands** (palette category *rung*): pull, sync, watch start/stop/toggle, status, compile file / PLC / hardware, test all / this block, go online / offline, online state, connect, interfaces, download, open in TIA Portal, resolve (keep mine / take TIA's), open rung.toml, show output, restart language server. While `rung watch` runs, pull is not needed (watch keeps both sides in sync) and the extension says so instead of failing on the locked workspace.
- **Tests**: `npm run test:e2e` in `editors/vscode` runs integration tests inside a real VS Code (a fresh folder, a fake-bridge project, and a fresh mirror of the fixture project when TIA Portal has it open); see `editors/vscode/README.md`.
- **Settings** (`rung.*`): command, auto-start watch, terminal reuse, output verbosity, CodeLens, compile on save (skipped while watch runs), status bar, project view grouping and read-only objects, online-state refresh interval (0 = off, only while watch runs), download confirmation (`typeName` or `modal`, user settings only), download defaults (hardware, all blocks, start after) and `rung.download.allow` (empty; leave it that way).

Keys: `alt+q` and then a letter, the same letters as in Zed below: `s` sync, `w` watch, `b` compile file, `shift+b` compile PLC, `h` hardware, `t` test block, `shift+t` test all, `o` online, `f` offline, `i` interfaces, `m` compare with the PLC, `d` download, `e` open in TIA Portal, `p` pull, `q` list of actions, and in VS Code also `c` connect and `r` rename in TIA Portal. They are active only in a folder with `rung.toml`; `b`, `t` and `e` only in SCL editors.

## Zed

Zed → Extensions → install **Siemens SCL**. Until it is listed there: *Install Dev Extension* → choose `editors/zed` (needs Rust via rustup on PATH). The extension gives you:

- SCL highlighting, outline and the rung language server for `.scl`, `.db`, `.udt` and `.s7dcl`.
- A run button (▶) in the gutter next to every block header: compile this block, test it, or open it in TIA Portal.
- Tasks for everything else (*task: spawn*, or `ctrl-shift-r` in many setups): sync, preview sync (what goes where, nothing written), turn on writes, who writes the selected name, watch, compile PLC, compile hardware, test, go online/offline, interfaces, download (it asks you to type the PLC name first), open in TIA Portal, pull, views, resolve conflicts.
- Snippets: `fb`, `fc`, `db`, `udt`, `if`, `ife`, `case`, `for`, `while`, `region`, `ton`, `rtrig`, `seq`.
- Live values at the end of each line (below).

TwinCAT and CODESYS `.st` files: install the **Structured Text** extension as well; rung's language server serves its files too. rung's MCP tools in Zed's agent panel: `rung setup --agents zed` writes them into the project's `.zed/settings.json` (`context_servers.rung`).

Zed extensions cannot add their own side panels or buttons, so there is no rung sidebar in Zed; VS Code has one.

The language server is `rung` from PATH; without one, the extension installs `@rung-plc/cli` from npm into its own folder and runs it with Zed's Node.js (updated once a session). The tasks run `rung` in a terminal, so they need it on PATH. To point the language server somewhere else, see below. If `.scl` files open as another language, map them in settings: `"file_types": { "SCL": ["scl", "db", "udt"] }`.

```json
{
  "lsp": {
    "rung": { "binary": { "path": "C:/Program Files/nodejs/node.exe", "arguments": ["C:/path/to/rung/packages/cli/dist/index.js", "lsp", "--stdio"] } }
  }
}
```

**Live values**, like TIA Portal's *Monitoring on*: in an open block, choose **Monitor values** from the code actions (an FB with several instance DBs offers one per instance). The values appear at the line ends twice a second, read only; **Stop monitoring**, editing or closing the block ends it. It needs `[live.webapi]` in `rung.toml` (or `rung simulate` as the PLC), inlay hints on, and the Web API password in the language server's environment:

```json
{
  "inlay_hints": { "enabled": true },
  "lsp": { "rung": { "binary": { "env": { "RUNG_WEBAPI_PASSWORD": "…" } } } }
}
```

Suggested keys (`keymap.json`): `alt-q` and then a letter.

```json
{
  "context": "Workspace",
  "bindings": {
    "alt-q s": ["task::Spawn", { "task_name": "rung: sync" }],
    "alt-q w": ["task::Spawn", { "task_name": "rung: watch (keep in sync)" }],
    "alt-q b": ["task::Spawn", { "task_name": "rung: compile this block" }],
    "alt-q shift-b": ["task::Spawn", { "task_name": "rung: compile PLC" }],
    "alt-q h": ["task::Spawn", { "task_name": "rung: compile hardware" }],
    "alt-q t": ["task::Spawn", { "task_name": "rung: test this block" }],
    "alt-q shift-t": ["task::Spawn", { "task_name": "rung: test all" }],
    "alt-q o": ["task::Spawn", { "task_name": "rung: go online" }],
    "alt-q f": ["task::Spawn", { "task_name": "rung: go offline" }],
    "alt-q i": ["task::Spawn", { "task_name": "rung: interfaces and reachable devices" }],
    "alt-q d": ["task::Spawn", { "task_name": "rung: download to PLC (asks first)" }],
    "alt-q m": ["task::Spawn", { "task_name": "rung: compare with PLC" }],
    "alt-q e": ["task::Spawn", { "task_name": "rung: open in TIA Portal" }],
    "alt-q p": ["task::Spawn", { "task_name": "rung: pull from TIA Portal" }],
    "alt-q q": ["task::Spawn", { "task_name": "rung: status" }]
  }
}
```

## Neovim (0.11+)

```lua
vim.filetype.add({ extension = { scl = "scl", db = "scl", udt = "scl" } })

vim.lsp.config("rung", {
  cmd = { "rung", "lsp", "--stdio" },
  filetypes = { "scl" },
  root_markers = { "rung.toml" },
})
vim.lsp.enable("rung")

-- highlighting with nvim-treesitter
local parsers = require("nvim-treesitter.parsers").get_parser_configs()
parsers.scl = {
  install_info = { url = "/path/to/rung/grammars/tree-sitter-scl", files = { "src/parser.c" } },
  filetype = "scl",
}
```

**Live values**: `vim.lsp.inlay_hint.enable(true)`, then `vim.lsp.buf.code_action()` → **Monitor values** (or the action naming the FB's instance DB); **Stop monitoring**, an edit or closing the block ends it. As in Zed it needs `[live.webapi]` in `rung.toml` and `RUNG_WEBAPI_PASSWORD` for the language server, e.g. `cmd_env = { RUNG_WEBAPI_PASSWORD = vim.env.RUNG_WEBAPI_PASSWORD }` in `vim.lsp.config`.

Copy `grammars/tree-sitter-scl/queries/*.scm` to `~/.config/nvim/queries/scl/`.

## TwinCAT 3 and plain IEC 61131-3 ST

Open a TwinCAT PLC project folder (or any folder of `.st` files) without `rung.toml`: the language server then indexes `.st`, `.TcPOU`, `.TcDUT` and `.TcGVL` files. It reads the Structured Text inside their CDATA sections, keeps positions exact, and understands PROGRAM, METHOD, GVL lists, identifiers written without `#`, and standard FBs. `rung test <folder>` runs YAML unit tests from `<folder>/tests/` against FBs, FCs and PROGRAMs. In VS Code the TwinCAT files keep XML highlighting and still get diagnostics, hover, go-to-definition and completion. The tree-sitter grammar reads IEC structured text too (PROGRAM, METHOD, PROPERTY, ACTION): Zed highlights `.st` files as *Structured Text*, and Neovim does when `st = "scl"` is added to its filetypes above. TwinCAT has no bridge: rung edits the files, and TwinCAT XAE builds and activates them. CODESYS projects sync both ways through CODESYS itself ([CODESYS](../codesys.md)).
