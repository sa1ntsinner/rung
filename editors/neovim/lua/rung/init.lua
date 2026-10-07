-- SPDX-License-Identifier: MIT
-- rung.nvim: rung in Neovim. The language server for SCL and test files, :Rung commands, tests with their
-- failures on the YAML lines, coverage in the sign column, recorded expectations and the debugger (nvim-dap).
-- Everything goes through the rung CLI; nothing here talks to TIA Portal or a PLC by itself.
local M = {}

M.config = {
  -- how to start rung (the release's rung, `npm install -g @rung-plc/cli`, or VS Code's "Put rung on PATH")
  cmd = { "rung" },
  -- environment for the language server, e.g. { RUNG_WEBAPI_PASSWORD = vim.env.RUNG_WEBAPI_PASSWORD }
  lsp_env = nil,
  -- run the case under the cursor after writing a test file
  test_on_save = false,
}

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  require("rung.lsp").setup(M.config)
  require("rung.commands").setup(M.config)
  require("rung.dap").setup(M.config)
end

return M
