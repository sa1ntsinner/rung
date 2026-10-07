-- SPDX-License-Identifier: MIT
-- :Rung impact: what the interface change of the buffer (saved or not) breaks against the version TIA Portal has,
-- in the quickfix list: calls that pass a parameter that went, instance DBs reinitialised on download, tests naming it.
local M = {}

function M.show(buf)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  local r, why = require("rung.lsp").request(buf, "rung/impact", { textDocument = { uri = vim.uri_from_bufnr(buf) } })
  if not r or r.reason then
    vim.notify("rung impact: " .. (r and r.reason or why), vim.log.levels.WARN)
    return nil
  end
  if #r.changes == 0 then
    vim.notify("rung: " .. r.block .. ": the interface is the one TIA Portal has; nothing outside the block is affected")
    return r
  end
  local items, file = {}, vim.api.nvim_buf_get_name(buf)
  for _, c in ipairs(r.changes) do
    local what = c.kind == "renamed" and (c.name .. " → " .. c.to) or c.name
    table.insert(items, { filename = file, lnum = 1, text = ("[%s] %s %s%s"):format(c.kind, c.section, what, c.before and c.after and ("  " .. c.before .. " → " .. c.after) or "") })
  end
  local function sites(list, label)
    for _, s in ipairs(list) do
      table.insert(items, { filename = vim.uri_to_fname(s.uri), lnum = s.line, type = #s.problems > 0 and "E" or "I", text = ("[%s] %s: %s"):format(label, s.block, #s.problems > 0 and table.concat(s.problems, "; ") or "compiles again, unchanged") })
    end
  end
  sites(r.calls, "call")
  for _, i in ipairs(r.instances) do
    table.insert(items, { filename = vim.uri_to_fname(i.uri), lnum = 1, type = "W", text = "[reinitialised on download] " .. i.name })
  end
  sites(r.tests, "test")
  vim.fn.setqflist({}, "r", { title = "rung impact: " .. r.block, items = items })
  vim.cmd("copen")
  return r
end

return M
