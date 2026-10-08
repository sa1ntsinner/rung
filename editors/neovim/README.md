# rung.nvim

rung in Neovim 0.11+: the language server for SCL and test files, `:Rung` commands, tests with their failures on the
YAML lines, coverage in the sign column, recorded expectations and the debugger. It needs `rung` on PATH (the release
folder, `npm install -g @rung-plc/cli`, or VS Code's **rung: Put rung on PATH**); nvim-dap is optional.

## Install

With lazy.nvim (the plugin lives in a folder of the rung repository):

```lua
{
  "sa1ntsinner/rung",
  config = function(plugin)
    vim.opt.rtp:append(plugin.dir .. "/editors/neovim")
    require("rung").setup({
      -- cmd = { "rung" },
      -- lsp_env = { RUNG_WEBAPI_PASSWORD = vim.env.RUNG_WEBAPI_PASSWORD },  -- live values
      -- test_on_save = true,
    })
  end,
}
```

Or put `editors/neovim` on the runtimepath yourself and call `require("rung").setup()`. Highlighting: the
tree-sitter grammar in `grammars/tree-sitter-scl` ([editors](../../docs/editors/README.md#neovim-011)).

## Commands

| Command | What it does |
|---|---|
| `:Rung test` / `:Rung test file` | runs the case under the cursor / the whole file; failures as diagnostics on their step's line and in the quickfix list, `✓ passed` on a passed case |
| `:Rung record` | runs the case, lists the block's values after the step at the cursor; `<Space>` picks, `<CR>` writes them into the step's `expect:` (one undo) |
| `:Rung coverage` | runs all tests with coverage and marks each executable SCL line in the sign column (green ran, red never ran); again clears it |
| `:Rung debug` | debugs the case under the cursor with nvim-dap: breakpoints in SCL, stepping, `dap.step_back()`, `dap.reverse_continue()`, variables, the REPL |
| `:Rung why [name]` | while debugging: why the value under the cursor is what it is: the statement that wrote it, its operands then, the branch that ran; `<CR>` opens a statement |
| `:Rung status` `pull` `sync` `preview` `watch` `compile` `compare` `online` `check` `test-all` | the CLI in a terminal split |
| `:Rung download` | `rung download` in a terminal split: it asks for the PLC's name there, and shows TIA Portal's questions |

`:checkhealth rung` checks rung, the workspace, the language server, nvim-dap and what `rung check` finds.

With nvim-dap, `require("dap").continue()` in a test file also offers **rung: debug the test case under the cursor**.

## Tests

From this folder, with the CLI built (`npx tsc -b` at the repository root):

```
nvim --headless --clean -l tests/smoke.lua
NVIM_DAP=<clone of nvim-dap> nvim --headless --clean -l tests/dap.lua
```
