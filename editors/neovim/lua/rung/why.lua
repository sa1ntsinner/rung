-- SPDX-License-Identifier: MIT
-- :Rung why [name] while debugging a test case (nvim-dap): why a value is what it is, as a tree in a floating
-- window. The statement that last wrote it, its operands as they were then (each explained in turn), the branch
-- that made it run. <CR> on a statement opens it; q closes.
local M = {}

local MARK = { value = "", write = "← ", condition = "because ", note = "· " }

--- Lines of a tree, and the place of each line that has one.
function M.render(node)
  local lines, places = {}, {}
  local function walk(n, depth)
    local text = n.kind == "value" and (n.text .. " = " .. (n.value or "?")) or (MARK[n.kind] .. n.text .. ((n.kind == "condition" and n.value) and ("  → " .. n.value) or ""))
    if n.kind == "write" and n.at then text = text .. (n.at.time and ("   (line %d, t = %d ms)"):format(n.at.line, n.at.time) or ("   (line %d)"):format(n.at.line)) end
    table.insert(lines, string.rep("  ", depth) .. text)
    if n.at then places[#lines] = n.at end
    for _, c in ipairs(n.children or {}) do walk(c, depth + 1) end
  end
  walk(node, 0)
  return lines, places
end

--- The tree as a Markdown list, for a report or a ticket.
function M.markdown(node)
  local out = {}
  local function walk(n, depth)
    local where = n.at and ("%s:%d"):format((vim.fn.fnamemodify(vim.uri_to_fname(n.at.uri), ":."):gsub("\\", "/")), n.at.line) or nil
    local text = n.kind == "value" and ("**`%s`** = `%s`"):format(n.text, n.value or "?")
      or n.kind == "write" and ("← `%s`%s"):format(n.text, where and (" (" .. where .. ")") or "")
      or n.kind == "condition" and ("because `%s`%s"):format(n.text, n.value and (" → " .. n.value) or "")
      or n.text
    table.insert(out, string.rep("  ", depth) .. "- " .. text)
    for _, c in ipairs(n.children or {}) do walk(c, depth + 1) end
  end
  walk(node, 0)
  return table.concat(out, "\n") .. "\n"
end

local function show(node)
  local lines, places = M.render(node)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  local width = 20
  for _, l in ipairs(lines) do width = math.max(width, vim.fn.strdisplaywidth(l) + 2) end
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "cursor", row = 1, col = 0, style = "minimal", border = "rounded", title = " why? ", footer = " <CR> open · Y copy as Markdown · q close ",
    width = math.min(width, vim.o.columns - 4), height = math.min(#lines, vim.o.lines - 6),
  })
  local function close() if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end end
  vim.keymap.set("n", "q", close, { buffer = buf, nowait = true })
  vim.keymap.set("n", "Y", function()
    vim.fn.setreg("+", M.markdown(node))
    vim.notify("rung: why? copied as Markdown")
  end, { buffer = buf, nowait = true })
  vim.keymap.set("n", "<Esc>", close, { buffer = buf, nowait = true })
  vim.keymap.set("n", "<CR>", function()
    local at = places[vim.api.nvim_win_get_cursor(win)[1]]
    if not at then return end
    close()
    vim.cmd("edit " .. vim.fn.fnameescape(vim.uri_to_fname(at.uri)))
    vim.api.nvim_win_set_cursor(0, { at.line, 0 })
  end, { buffer = buf, nowait = true })
  return buf, win
end

--- Outside the debugger: the block's writers with the values the PLC (or rung simulate) has now (rung why).
local function ask_live(expression, cb)
  local cli = require("rung.cli")
  local file = vim.api.nvim_buf_get_name(0)
  if vim.bo.filetype ~= "scl" or file == "" then
    vim.notify("rung: why works in an SCL block, or while debugging a test case (:Rung debug)", vim.log.levels.WARN)
    return
  end
  cli.capture({ "why", file, expression, "--json" }, { cwd = cli.root() }, function(r)
    local res, err = cli.json(r)
    if not res then
      vim.notify("rung why: " .. err, vim.log.levels.WARN)
      return cb and cb(nil)
    end
    if cb then return cb(res.tree, res.source) end
    vim.notify("rung: " .. res.source)
    show(res.tree)
  end)
end

--- Asks the debug session, or the PLC outside one; `cb` gets the tree (tests), otherwise it is shown.
function M.ask(expression, cb)
  expression = expression and expression ~= "" and expression or vim.fn.expand("<cWORD>"):match('#?"?[%a_][%w_."%[%]]*"?')
  if not expression then return end
  local ok, dap = pcall(require, "dap")
  local session = ok and dap.session()
  if not session or session.config.type ~= "rung" then return ask_live(expression, cb) end
  local frame = session.current_frame and session.current_frame.id or 0
  session:request("rungWhy", { expression = expression, frameId = frame, depth = 3 }, function(err, tree)
    if err then
      vim.notify("rung: why " .. expression .. ": " .. tostring(err.message or err), vim.log.levels.WARN)
      return cb and cb(nil)
    end
    if cb then return cb(tree) end
    show(tree)
  end)
end

return M
