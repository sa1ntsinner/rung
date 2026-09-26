# Editor setup

All editors use the same language server: `rung lsp --stdio` (run from the workspace folder, the one with `rung.toml`). It works offline on any OS; with `rung watch` running it also shows TIA Portal compile errors and sync conflicts.

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

- **rung sidebar** (activity bar): *Project* lists the mirrored objects by PLC, kind and TIA folder (or by block type) with conflict, changed and read-only marks; right-click to compile, test, open in TIA Portal or resolve a conflict. *PLC* shows whether `rung watch` runs (start/stop), each PLC's online state and connection, and Go online, Go offline, Compile PLC, Compile hardware, Interfaces…, Download…. A folder without `rung.toml` gets *Initialize from a TIA Portal project* (`rung init --project`).
- **Status bar**: watching / idle / conflicts / online PLCs; click for all actions.
- **CodeLens** above every block header and editor title buttons: Compile, Test, Open in TIA Portal. Compile messages land in Problems.
- **Interfaces…** runs `rung interfaces --scan`; after you pick an interface it offers to write `[plc.<name>]` into `rung.toml`.
- **Download…** shows a warning dialog with the PLC and what is downloaded, asks you to type the PLC name, then runs `rung download --yes` in its own terminal so you see every TIA question and answer. If TIA cancels (for example it wants to stop the CPU), it offers a retry that allows exactly that, with the same confirmation. It never downloads from CodeLens or on save.
- **Commands** (palette category *rung*): pull, sync, watch start/stop/toggle, status, compile file / PLC / hardware, test all / this block, go online / offline, online state, interfaces, download, open in TIA Portal, resolve (keep mine / take TIA's), open rung.toml, show output, restart language server.
- **Settings** (`rung.*`): command, auto-start watch, terminal reuse, output verbosity, CodeLens, compile on save (skipped while watch runs), status bar, project view grouping and read-only objects, online-state refresh interval (0 = off, only while watch runs), download confirmation (`typeName` or `modal`, user settings only), download defaults (hardware, all blocks, start after) and `rung.download.allow` (empty; leave it that way).

Keys: `alt+q` and then a letter, the same letters as in Zed below: `s` sync, `w` watch, `b` compile file, `shift+b` compile PLC, `h` hardware, `t` test block, `shift+t` test all, `o` online, `f` offline, `i` interfaces, `d` download, `e` open in TIA Portal, `p` pull, `q` list of actions. They are active only in a folder with `rung.toml`; `b`, `t` and `e` only in SCL editors.

## Zed

Zed → Extensions → *Install Dev Extension* → choose `editors/zed` (needs Rust via rustup on PATH). The extension gives you:

- SCL highlighting, outline and the rung language server for `.scl`, `.db` and `.udt`.
- A run button (▶) in the gutter next to every block header: compile this block, test it, or open it in TIA Portal.
- Tasks for everything else (*task: spawn*, or `ctrl-shift-r` in many setups): sync, watch, compile PLC, compile hardware, test, go online/offline, interfaces, download (it asks you to type the PLC name first), open in TIA Portal, pull, views, resolve conflicts.
- Snippets: `fb`, `fc`, `db`, `udt`, `if`, `ife`, `case`, `for`, `while`, `region`, `ton`, `rtrig`, `seq`.
- rung's MCP tools in Zed's agent panel (context server `rung`).

Zed extensions cannot add their own side panels or buttons, so there is no rung sidebar in Zed; VS Code has one.

The tasks run `rung`, so it has to be on PATH (or point the language server at it, below). If `.scl` files open as another language, map them in settings: `"file_types": { "SCL": ["scl", "db", "udt"] }`.

```json
{
  "lsp": {
    "rung": { "binary": { "path": "C:/Program Files/nodejs/node.exe", "arguments": ["C:/path/to/rung/packages/cli/dist/index.js", "lsp", "--stdio"] } }
  }
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

Copy `grammars/tree-sitter-scl/queries/*.scm` to `~/.config/nvim/queries/scl/`.

## TwinCAT 3 and plain IEC 61131-3 ST

Open a TwinCAT PLC project folder (or any folder of `.st` files) without `rung.toml`: the language server then indexes `.st`, `.TcPOU`, `.TcDUT` and `.TcGVL` files. It reads the Structured Text inside their CDATA sections, keeps positions exact, and understands PROGRAM, METHOD, GVL lists, identifiers written without `#`, and standard FBs. `rung test <folder>` runs YAML unit tests from `<folder>/tests/` against FBs, FCs and PROGRAMs. In VS Code the TwinCAT files keep XML highlighting and still get diagnostics, hover, go-to-definition and completion. Zed and Neovim (tree-sitter) do not support the IEC dialect yet. There is no TwinCAT or CODESYS bridge: rung edits the files, and TwinCAT XAE builds and activates them.
