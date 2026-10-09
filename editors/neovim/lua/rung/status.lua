-- SPDX-License-Identifier: MIT
-- A statusline part (lualine: `lualine_x = { require("rung.status").get }`): whether rung watch runs for this
-- workspace, files in conflict with TIA Portal, and errors of the last sync. Read from .rung/ at most every 2 s.
local cli = require("rung.cli")
local M = {}

local cache = { at = 0, root = nil, text = "" }

local function json(path)
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path), "\n")) end)
  return ok and type(data) == "table" and data or nil
end

--- The text for this workspace's state, e.g. "rung ● watch · 1 conflict · 2 errors"; "" outside a rung workspace.
function M.compute(root)
  if not root or vim.fn.filereadable(root .. "/rung.toml") == 0 then return "" end
  local parts = { "rung" }
  local owner = json(root .. "/.rung/owner.json")
  if owner and owner.pid and vim.uv.kill(owner.pid, 0) == 0 then parts[1] = "rung ● watch" end
  local state = json(root .. "/.rung/state.json")
  local conflicts = 0
  for _, o in pairs(state and state.objects or {}) do
    if o.status == "conflicted" then conflicts = conflicts + 1 end
  end
  if conflicts > 0 then table.insert(parts, conflicts .. (conflicts == 1 and " conflict" or " conflicts")) end
  local diags = json(root .. "/.rung/diagnostics.json")
  local errors = 0
  for _, d in ipairs(diags and diags.items or {}) do
    if d.severity == "error" then errors = errors + 1 end
  end
  if errors > 0 then table.insert(parts, errors .. (errors == 1 and " error" or " errors")) end
  return table.concat(parts, " · ")
end

function M.get()
  local root = cli.root()
  local now = vim.uv.now()
  if root ~= cache.root or now - cache.at > 2000 then cache = { at = now, root = root, text = M.compute(root) } end
  return cache.text
end

return M
