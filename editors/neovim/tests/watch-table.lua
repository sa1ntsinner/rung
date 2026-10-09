-- SPDX-License-Identifier: MIT
-- nvim --headless --clean -l editors/neovim/tests/watch-table.lua
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(debug.getinfo(1, "S").source:sub(2))))
vim.opt.rtp:prepend(here)
local args, callback
package.loaded["rung.cli"] = { available = function() return true end, root = function() return vim.fn.getcwd() end,
  argv = function(a) args = a; return { "unused" } end }
vim.fn.jobstart = function(_, opts) callback = opts.on_stdout; return 123 end
vim.fn.jobstop = function() return 1 end
local live = require("rung.live")
live.command({ "table", "plc/P/watch/Watch.xml" })
assert(vim.tbl_contains(args, "--table"))
callback(123, { vim.json.encode({ plan = { table = { name = "Watch", rows = {
  { key = "row:1", name = '"DB".x', comments = { ["en-US"] = "First row" } },
  { key = "row:2", name = '"DB".x', comments = {} },
} }, errors = {} } }), "" })
callback(123, { vim.json.encode({ at = 10, values = { ["row:1"] = 4, ["row:2"] = 4 }, observedAt = { ["row:1"] = 10, ["row:2"] = 10 } }), "" })
vim.wait(100, function() return table.concat(vim.api.nvim_buf_get_lines(live.buf, 0, -1, false), "\n"):find("First row", 1, true) ~= nil end)
local text = table.concat(vim.api.nvim_buf_get_lines(live.buf, 0, -1, false), "\n")
assert(text:find("Watch", 1, true) and text:find("First row", 1, true), text)
assert(live.seen["row:1"].value == 4 and live.seen["row:2"].value == 4)
callback(123, { vim.json.encode({ at = 11, values = { ["row:1"] = 4 }, observedAt = { ["row:1"] = 10 } }), "" })
assert(#live.seen["row:1"].history == 1, "heartbeat must not add an observation")
live.toggle()
assert(live.job == nil)
print("watch table: passed")
vim.cmd("qa!")
