-- SPDX-License-Identifier: MIT
-- :Rung xref: TIA Portal's cross-reference of the open block (who uses it, what it uses; HMI and alarms too) in the
-- quickfix list; an entry rung mirrors opens its file.
local cli = require("rung.cli")
local M = {}

function M.show(buf, cb)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  local file = vim.api.nvim_buf_get_name(buf)
  local root = cli.root(buf)
  if file == "" or not root then
    vim.notify("rung: open a block, DB or data type of a rung workspace", vim.log.levels.WARN)
    return
  end
  vim.notify("rung: asking TIA Portal for the cross-reference…")
  cli.capture({ "xref", file, "--json" }, { cwd = root }, function(r)
    local res, why = cli.json(r)
    if not res then
      vim.notify("rung xref: " .. why, vim.log.levels.ERROR)
      return cb and cb(nil)
    end
    local items = {}
    for _, row in ipairs(res.rows or {}) do
      table.insert(items, {
        filename = row.path and vim.fs.joinpath(root, row.path) or nil,
        lnum = 1,
        text = ("[%s] %s  %s · %s%s"):format(row.relation, row.name, row.access, row.type, row.location and ("  " .. row.location) or ""),
      })
    end
    vim.fn.setqflist({}, "r", { title = "TIA Portal cross-reference: " .. vim.fn.fnamemodify(file, ":t:r"), items = items })
    if #items == 0 then vim.notify("rung: TIA Portal knows no cross references of " .. vim.fn.fnamemodify(file, ":t:r")) else vim.cmd("copen") end
    if cb then cb(res.rows) end
  end)
end

return M
