-- SPDX-License-Identifier: MIT
-- Running the rung CLI: captured (JSON answers) or in a terminal split (anything a person should watch).
local M = {}

local function config()
  return require("rung").config
end

-- a folder without rung.toml (TwinCAT, plain ST, an example) is a workspace by its tests/ folder, as for rung test
M.markers = { "rung.toml", "tests" }

--- The rung workspace of a buffer, or of the current directory.
function M.root(buf)
  return vim.fs.root(buf or 0, M.markers) or vim.fs.root(vim.fn.getcwd(), M.markers)
end

--- The command line for rung with these arguments.
function M.argv(args)
  local argv = vim.list_extend({}, config().cmd)
  return vim.list_extend(argv, args)
end

--- Runs rung and calls back with { code, stdout, stderr } on the main loop; `sync` waits instead.
function M.capture(args, opts, cb)
  opts = opts or {}
  local run = vim.system(M.argv(args), { cwd = opts.cwd or M.root(), text = true }, cb and vim.schedule_wrap(cb) or nil)
  if not cb then return run:wait() end
  return run
end

--- JSON on stdout, or nil and why not.
function M.json(r)
  local ok, value = pcall(vim.json.decode, r.stdout or "", { luanil = { object = true, array = true } })
  if ok and type(value) == "table" then return value end
  local why = vim.trim((r.stderr or "") .. "\n" .. (r.stdout or ""))
  return nil, why ~= "" and why or ("rung exited with " .. tostring(r.code))
end

--- Runs rung in a terminal split at the bottom, where its questions can be answered.
function M.terminal(args, opts)
  opts = opts or {}
  vim.cmd("botright " .. (opts.height or 12) .. "split")
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_win_set_buf(0, buf)
  vim.fn.jobstart(M.argv(args), { term = true, cwd = opts.cwd or M.root(), on_exit = opts.on_exit })
  vim.bo[buf].bufhidden = "wipe"
  vim.cmd("startinsert")
  return buf
end

return M
