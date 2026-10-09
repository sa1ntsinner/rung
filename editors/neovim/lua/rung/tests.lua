-- SPDX-License-Identifier: MIT
-- Tests: the case under the cursor or the whole file through `rung test --json`; a failed expectation shows on
-- its step's line (diagnostics) and in the quickfix list; a passed case gets a mark on its name.
local cli = require("rung.cli")
local M = {}

M.ns = vim.api.nvim_create_namespace("rung.tests")

--- The cases of a test buffer as written: { line (0-based), name }.
function M.cases(buf)
  return M.cases_of(vim.api.nvim_buf_get_lines(buf or 0, 0, -1, false))
end

--- The cases in a test file's lines: { line (0-based, its dash), name }, in file order, whatever key comes first.
function M.cases_of(lines)
  local out, inside, dash, current = {}, false, nil, nil
  local unquote = function(s) return (s:gsub("^[\"']", ""):gsub("[\"']$", "")) end
  for i, l in ipairs(lines) do
    if l:match("^cases:") then
      inside, dash, current = true, nil, nil
    elseif l:match("^%S") then
      inside = false
    elseif inside then
      local indent, rest = l:match("^(%s*)%-%s*(.*)$")
      if indent and (dash == nil or #indent == dash) then
        -- a case: an item of the cases list (steps are items deeper in)
        dash = #indent
        current = { line = i - 1 }
        table.insert(out, current)
        local name = rest:match("^name:%s*(.-)%s*$") or rest:match("^{.-%f[%w]name:%s*([^,}]+)")
        if name then current.name = unquote(vim.trim(name)) end
      elseif current and not current.name then
        local pad, name = l:match("^(%s+)name:%s*(.-)%s*$")
        if name and #pad == dash + 2 then current.name = unquote(name) end
      end
    end
  end
  for n, c in ipairs(out) do c.name = c.name or ("case " .. n) end
  return out
end

--- The case (from 0) the cursor is in, or nil above the first case.
function M.case_at_cursor(buf, line)
  line = line or (vim.api.nvim_win_get_cursor(0)[1] - 1)
  local at
  for i, c in ipairs(M.cases(buf)) do
    if c.line <= line then at = i - 1 end
  end
  return at
end

--- The test file's path as rung test names it (tests/…), or nil outside a workspace.
function M.rel(buf)
  local root = cli.root(buf)
  local name = vim.fs.normalize(vim.api.nvim_buf_get_name(buf or 0))
  if not root or name == "" then return nil end
  root = vim.fs.normalize(root)
  if name:lower():sub(1, #root + 1) ~= (root .. "/"):lower() then return nil end
  return name:sub(#root + 2)
end

local function show(buf, results)
  vim.diagnostic.reset(M.ns, buf)
  vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1)
  local diags, qf, passed, total = {}, {}, 0, 0
  local function add(line, msg)
    local lnum = math.max(0, (line or 1) - 1)
    table.insert(diags, { lnum = lnum, col = 0, severity = vim.diagnostic.severity.ERROR, source = "rung test", message = msg })
    table.insert(qf, { bufnr = buf, lnum = lnum + 1, col = 1, text = msg, type = "E" })
  end
  for _, f in ipairs(results.files or {}) do
    if f.error then
      total = total + 1
      add(f.errorLine, f.error)
    end
    for _, c in ipairs(f.cases or {}) do
      total = total + 1
      if c.passed then
        passed = passed + 1
        if c.line then
          vim.api.nvim_buf_set_extmark(buf, M.ns, c.line - 1, 0, { virt_text = { { "✓ passed", "DiagnosticOk" } }, virt_text_pos = "eol" })
        end
      end
      if c.error then add(c.errorLine or c.line, (c.errorStep and ("step " .. c.errorStep .. ": ") or "") .. c.error) end
      for _, x in ipairs(c.failures or {}) do
        add(x.line or c.line, ("step %d: %s expected %s, got %s%s"):format(x.step, x.name, vim.json.encode(x.expected), vim.json.encode(x.actual), x.note and (" (" .. x.note .. ")") or ""))
      end
    end
  end
  vim.diagnostic.set(M.ns, buf, diags)
  vim.fn.setqflist({}, "r", { title = "rung test", items = qf })
  return passed, total
end

--- Runs the case under the cursor (`what` = "case") or the whole file ("file"); calls back with the results.
function M.run(what, buf, cb)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  local rel = M.rel(buf)
  if not rel or not rel:match("^tests/.+%.test%.ya?ml$") then
    vim.notify("rung: open a test file under tests/ (….test.yaml)", vim.log.levels.WARN)
    return
  end
  if vim.bo[buf].modified then vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end) end
  if not cli.available() then return end
  local args = { "test", "--json" }
  if what == "case" then
    local i = M.case_at_cursor(buf)
    if not i then
      vim.notify("rung: put the cursor in a case", vim.log.levels.WARN)
      return
    end
    vim.list_extend(args, { "--case", rel .. "#" .. i })
  else
    vim.list_extend(args, { "--filter", rel })
  end
  cli.capture(args, {}, function(r)
    local results, why = cli.json(r)
    if not results then
      vim.notify("rung test: " .. why, vim.log.levels.ERROR)
      return cb and cb(nil, why)
    end
    local passed, total = show(buf, results)
    vim.notify(("rung test: %d/%d passed"):format(passed, total), passed == total and vim.log.levels.INFO or vim.log.levels.WARN)
    if cb then cb(results) end
  end)
end

return M
