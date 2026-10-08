-- SPDX-License-Identifier: MIT
-- The debugger, when nvim-dap is installed: `rung debug` speaks DAP, so breakpoints in SCL, stepping (also back:
-- dap.step_back(), dap.reverse_continue()), variables and the REPL work as for any language.
local M = {}

--- The launch configuration for one case of a test file (case from 0).
function M.configuration(file, case)
  return { type = "rung", request = "launch", name = "Debug test case", test = file, case = case, stopOnEntry = true }
end

function M.setup()
  local ok, dap = pcall(require, "dap")
  if not ok then return end
  local cli = require("rung.cli")
  local argv = cli.argv({ "debug", "--stdio" })
  dap.adapters.rung = function(callback)
    callback({ type = "executable", command = argv[1], args = vim.list_slice(argv, 2), options = { cwd = cli.root() } })
  end
  dap.configurations.yaml = dap.configurations.yaml or {}
  table.insert(dap.configurations.yaml, {
    type = "rung",
    request = "launch",
    name = "rung: debug the test case under the cursor",
    test = function() return vim.api.nvim_buf_get_name(0) end,
    case = function() return require("rung.tests").case_at_cursor() or 0 end,
    stopOnEntry = true,
  })
end

--- :Rung debug: the case under the cursor in nvim-dap.
function M.debug_case()
  local ok, dap = pcall(require, "dap")
  if not ok then
    vim.notify("rung: debugging needs nvim-dap (mfussenegger/nvim-dap)", vim.log.levels.WARN)
    return
  end
  local case = require("rung.tests").case_at_cursor()
  if not case then
    vim.notify("rung: put the cursor in a case of a test file", vim.log.levels.WARN)
    return
  end
  dap.run(M.configuration(vim.api.nvim_buf_get_name(0), case))
end

return M
