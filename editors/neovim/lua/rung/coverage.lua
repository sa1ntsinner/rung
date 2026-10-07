-- SPDX-License-Identifier: MIT
-- Coverage: `rung test --coverage` over all tests, each executable SCL line marked in the sign column
-- (ran / never ran). :Rung coverage again clears it.
local cli = require("rung.cli")
local M = {}

M.ns = vim.api.nvim_create_namespace("rung.coverage")
--- lines by absolute path (normalized): { [line] = count }
M.files = nil

vim.api.nvim_set_hl(0, "RungCovered", { default = true, link = "DiagnosticOk" })
vim.api.nvim_set_hl(0, "RungUncovered", { default = true, link = "DiagnosticError" })

--- Line counts from lcov text: { [path] = { [line] = count } }, paths as written.
function M.parse(text)
  local out, cur = {}, nil
  for l in (text .. "\n"):gmatch("([^\r\n]*)\r?\n") do
    local sf = l:match("^SF:(.+)$")
    if sf then
      cur = out[sf] or {}
      out[sf] = cur
    elseif cur then
      local line, n = l:match("^DA:(%d+),(%d+)")
      if line then cur[tonumber(line)] = (cur[tonumber(line)] or 0) + tonumber(n) end
      if l == "end_of_record" then cur = nil end
    end
  end
  return out
end

local function key(path)
  return vim.fs.normalize(path):lower()
end

--- Marks a buffer's lines from the last run.
function M.mark(buf)
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  local lines = M.files and M.files[key(vim.api.nvim_buf_get_name(buf))]
  if not lines then return end
  local count = vim.api.nvim_buf_line_count(buf)
  for line, n in pairs(lines) do
    if line <= count then
      vim.api.nvim_buf_set_extmark(buf, M.ns, line - 1, 0, { sign_text = "▎", sign_hl_group = n > 0 and "RungCovered" or "RungUncovered" })
    end
  end
end

function M.clear()
  M.files = nil
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) then vim.api.nvim_buf_clear_namespace(b, M.ns, 0, -1) end
  end
end

--- Runs all tests with coverage and marks the open SCL buffers (and those opened later); toggles off when shown.
function M.toggle(cb)
  if M.files then
    M.clear()
    return
  end
  local root = cli.root()
  if not root then
    vim.notify("rung: no rung workspace here (a folder with rung.toml or tests/)", vim.log.levels.WARN)
    return
  end
  local lcov = vim.fn.tempname() .. ".info"
  cli.capture({ "test", "--coverage", lcov }, { cwd = root }, function(r)
    local f = io.open(lcov, "r")
    if not f then
      vim.notify("rung test --coverage: " .. vim.trim(r.stderr .. r.stdout), vim.log.levels.ERROR)
      return cb and cb(nil)
    end
    local text = f:read("*a")
    f:close()
    os.remove(lcov)
    M.files = {}
    for path, lines in pairs(M.parse(text)) do M.files[key(vim.fs.joinpath(root, path))] = lines end
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(b) then M.mark(b) end
    end
    local summary = (r.stdout or ""):match("coverage: [^\n]*")
    vim.notify("rung " .. (summary or "coverage done"))
    if cb then cb(M.files) end
  end)
end

vim.api.nvim_create_autocmd("BufReadPost", {
  group = vim.api.nvim_create_augroup("rung.coverage", { clear = true }),
  callback = function(a)
    if M.files then M.mark(a.buf) end
  end,
})

return M
