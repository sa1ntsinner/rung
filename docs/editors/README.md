# Editor setup

All editors use the same language server: `rung lsp --stdio` (run from the workspace folder, the one with `rung.toml`). It works offline on any OS; with `rung watch` running it also shows TIA Portal compile errors and sync conflicts.

## VS Code (and Cursor, Windsurf, VSCodium)

Install `editors/vscode/rung-scl.vsix` (build it with `npm run package` in that folder):

```
code --install-extension editors/vscode/rung-scl.vsix
```

If `rung` is not on PATH, set in settings:

```json
"rung.command": ["node", "C:/path/to/rung/packages/cli/dist/index.js"]
```

Commands: *rung: Pull*, *Sync*, *Start watch*, *Status*, *Resolve conflict — keep my file / take TIA version*, *Restart language server*.

## Zed

Zed → Extensions → *Install Dev Extension* → choose `editors/zed`. The grammar is built from `grammars/tree-sitter-scl`. Point Zed at rung if it is not on PATH:

```json
{
  "lsp": {
    "rung": { "binary": { "path": "node", "arguments": ["C:/path/to/rung/packages/cli/dist/index.js", "lsp", "--stdio"] } }
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
