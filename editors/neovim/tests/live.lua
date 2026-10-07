-- SPDX-License-Identifier: MIT
-- Headless check of :Rung live against a virtual PLC (rung simulate) in a copy of the given workspace:
--   RUNG_LIVE_WS=<a rung workspace with a DB "Fx_Global"> nvim --headless --clean -l tests/live.lua
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p"))))
local repo = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(here)
if not vim.env.RUNG_LIVE_WS then
  print("skipped: set RUNG_LIVE_WS to a workspace with a DB Fx_Global")
  vim.cmd("qa!")
end
local failures = 0
local function check(name, ok, detail)
  print((ok and "ok   " or "FAIL ") .. name .. ((not ok and detail) and (": " .. vim.inspect(detail)) or ""))
  if not ok then failures = failures + 1 end
end

local ws = vim.fs.normalize(vim.fn.tempname())
vim.fn.mkdir(ws, "p")
vim.system({ "robocopy", vim.env.RUNG_LIVE_WS, ws, "rung.toml", "/NFL", "/NDL", "/NJH", "/NJS" }):wait()
vim.system({ "robocopy", vim.env.RUNG_LIVE_WS .. "/plc", ws .. "/plc", "/E", "/NFL", "/NDL", "/NJH", "/NJS" }):wait()
vim.fn.chdir(ws)
local cli = { "node", repo .. "/packages/cli/dist/index.js" }
local out = ""
local sim = vim.system(vim.list_extend(vim.deepcopy(cli), { "simulate", "--address", "127.0.0.1", "--port", "0", "--cycle", "20" }), { cwd = ws, stdout = function(_, d) out = out .. (d or "") end, stderr = function(_, d) out = out .. (d or "") end })
local url
vim.wait(30000, function()
  url = out:match("virtual PLC at (http://%S+)")
  return url ~= nil
end, 100)
check("simulate listens", url ~= nil, out)
if url then
  local f = io.open(ws .. "/rung.toml", "a")
  f:write('\n[live.webapi]\nurl = "' .. url .. '"\nuser = "any"\n')
  f:close()
  vim.env.RUNG_WEBAPI_PASSWORD = "x"
  require("rung").setup({ cmd = cli })
  local live = require("rung.live")
  live.add('"Fx_Global".Count')
  check("split open", live.win and vim.api.nvim_win_is_valid(live.win))
  local ok = vim.wait(30000, function() return live.seen['"Fx_Global".Count'] and live.seen['"Fx_Global".Count'].value ~= nil end, 100)
  check("value read", ok, live.seen)
  local text = table.concat(vim.api.nvim_buf_get_lines(live.buf, 0, -1, false), "\n")
  check("value shown", text:find('"Fx_Global".Count', 1, true) ~= nil and text:find("0", 1, true) ~= nil, text)
  live.toggle()
  check("job stopped with the split", live.job == nil)
end
sim:kill(9)
print(failures == 0 and "all passed" or (failures .. " failed"))
vim.cmd(failures == 0 and "qa!" or "cq!")
