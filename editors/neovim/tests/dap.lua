-- SPDX-License-Identifier: MIT
-- Headless check of the debugger through nvim-dap (needs a clone of mfussenegger/nvim-dap in NVIM_DAP):
--   NVIM_DAP=<path> nvim --headless --clean -l tests/dap.lua      (from editors/neovim)
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p"))))
local repo = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(here)
if not vim.env.NVIM_DAP then
  print("skipped: set NVIM_DAP to a clone of nvim-dap")
  vim.cmd("qa!")
end
vim.opt.rtp:prepend(vim.env.NVIM_DAP)
vim.cmd("filetype on")

local failures = 0
local function check(name, ok, detail)
  print((ok and "ok   " or "FAIL ") .. name .. ((not ok and detail) and (": " .. vim.inspect(detail)) or ""))
  if not ok then failures = failures + 1 end
end

local ws = vim.fs.normalize(vim.fn.tempname())
vim.fn.mkdir(ws .. "/blocks", "p")
vim.fn.mkdir(ws .. "/tests", "p")
for _, f in ipairs({ "blocks/FB_Conveyor.scl", "tests/conveyor.test.yaml" }) do
  vim.fn.writefile(vim.fn.readfile(repo .. "/examples/conveyor/" .. f, "b"), ws .. "/" .. f, "b")
end
vim.fn.chdir(ws)
require("rung").setup({ cmd = { "node", repo .. "/packages/cli/dist/index.js" } })
local dap = require("dap")

local stops = 0
dap.listeners.after.event_stopped["rung-test"] = function() stops = stops + 1 end
local ended = false
dap.listeners.after.event_terminated["rung-test"] = function() ended = true end

vim.cmd("edit tests/conveyor.test.yaml")
vim.api.nvim_win_set_cursor(0, { 6, 0 }) -- in the first case
require("rung.dap").debug_case()
local function frame()
  local s = dap.session()
  return s and s.current_frame
end
check("stopped on entry", vim.wait(30000, function() return stops == 1 and frame() ~= nil end, 50))
local first = frame()
check("in the block", first and first.source and first.source.path:match("FB_Conveyor%.scl$") ~= nil, first)
dap.step_over()
check("stepped", vim.wait(10000, function() return stops == 2 and frame() and frame().line ~= first.line end, 50), frame())
dap.step_back()
check("stepped back", vim.wait(10000, function() return stops == 3 and frame() and frame().line == first.line end, 50), frame())
local got
dap.session():evaluate("Stop", function(err, resp) got = err and tostring(err) or resp.result end)
vim.wait(5000, function() return got ~= nil end, 50)
check("evaluate", got == "TRUE", got)
local tree
require("rung.why").ask("Motor", function(t) tree = t or false end)
vim.wait(10000, function() return tree ~= nil end, 50)
check("why", tree and tree.kind == "value" and tree.text == "#Motor", tree)
local lines = require("rung.why").render(tree or { kind = "note", text = "", children = {} })
check("why renders", #lines >= 1, lines)
dap.continue()
check("ran to the end", vim.wait(30000, function() return ended end, 50))

print(failures == 0 and "all passed" or (failures .. " failed"))
vim.cmd(failures == 0 and "qa!" or "cq!")
