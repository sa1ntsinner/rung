-- SPDX-License-Identifier: MIT
-- Record expectations: run the case under the cursor, list the block's values after the step there (a step
-- with cycle: or advance:), and write the ones picked into that step's expect: through the language server,
-- as one undoable change. Nothing is written that was not picked.
local cli = require("rung.cli")
local lsp = require("rung.lsp")
local tests = require("rung.tests")
local M = {}

local function shown(v)
  if type(v) == "boolean" then return v and "true" or "false" end
  return tostring(v)
end

--- The step (0-based case and step) the values are recorded for: the one at the cursor, or the last one before
--- it that runs cycles.
local function target(model, line)
  local case
  for _, c in ipairs(model.cases or {}) do
    if c.line <= line then case = c end
  end
  if not case then return nil, "put the cursor in a case" end
  local step, here
  for _, s in ipairs(case.steps or {}) do
    if s.line <= line then
      here = s
      if s.cycle or s.advance then step = s end
    end
  end
  if not step then return nil, "put the cursor on a step that runs cycles (cycle: or advance:)" end
  -- a step of only expect: after it is where its values go; otherwise the step that ran the cycles
  local into = (here and here.index > step.index and not here.cycle and not here.advance and not here.set) and here or step
  return case, step, into
end

--- Applies one rung/testEdit operation to the buffer as it is now.
local function apply(buf, op)
  local client = lsp.client(buf)
  local plan, why = lsp.request(buf, "rung/testEdit", { textDocument = { uri = vim.uri_from_bufnr(buf), version = vim.lsp.util.buf_versions[buf] }, op = op })
  if not plan then return false, why end
  if not plan.ok then return false, plan.reason end
  local edits = vim.tbl_map(function(e) return { range = e.range, newText = e.newText } end, plan.edits)
  vim.lsp.util.apply_text_edits(edits, buf, client.offset_encoding)
  return true
end

--- Writes the picked { key, value } into the step's expect:, one undo step for all.
function M.write(buf, case, step, picked)
  local expected = {}
  for _, e in ipairs(step.expect and step.expect.entries or {}) do expected[e.key:upper()] = e end
  local first = true
  for _, p in ipairs(picked) do
    local has = expected[p.key:upper()]
    if not (has and has.text == p.value) then
      if not first then vim.api.nvim_buf_call(buf, function() vim.cmd("undojoin") end) end
      first = false
      local op = has and { op = "setValue", case = case.index, step = step.index, part = "expect", key = has.key, value = p.value }
        or { op = "addEntry", case = case.index, step = step.index, part = "expect", key = p.key, value = p.value }
      local ok, why = apply(buf, op)
      if not ok then return false, p.key .. " was not written: " .. tostring(why) end
    end
  end
  return true
end

--- A floating list to pick from: <Space> or x toggles, <CR> writes, q or <Esc> cancels.
local function pick(title, items, done)
  local buf = vim.api.nvim_create_buf(false, true)
  local width = #title + 4
  local function render()
    local lines = {}
    for _, it in ipairs(items) do
      local l = ("[%s] %s = %s%s"):format(it.on and "x" or " ", it.key, it.value, it.note and ("   " .. it.note) or "")
      width = math.max(width, #l + 2)
      table.insert(lines, l)
    end
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
  end
  render()
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor", style = "minimal", border = "rounded", title = " " .. title .. " ", footer = " <Space> pick · a all · <CR> write · q cancel ",
    width = math.min(width, vim.o.columns - 4), height = math.min(#items, vim.o.lines - 6),
    row = math.floor((vim.o.lines - #items) / 3), col = math.floor((vim.o.columns - width) / 2),
  })
  local function close(result)
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
    done(result)
  end
  local function toggle()
    local it = items[vim.api.nvim_win_get_cursor(win)[1]]
    it.on = not it.on
    render()
  end
  for _, k in ipairs({ "<Space>", "x" }) do vim.keymap.set("n", k, toggle, { buffer = buf, nowait = true }) end
  -- a: all picked, or none when all are
  vim.keymap.set("n", "a", function()
    local all = vim.iter(items):all(function(i) return i.on end)
    for _, i in ipairs(items) do i.on = not all end
    render()
  end, { buffer = buf, nowait = true })
  vim.keymap.set("n", "<CR>", function() close(vim.tbl_filter(function(i) return i.on end, items)) end, { buffer = buf, nowait = true })
  for _, k in ipairs({ "q", "<Esc>" }) do vim.keymap.set("n", k, function() close(nil) end, { buffer = buf, nowait = true }) end
  return buf, win
end

--- :Rung record. `choose` replaces the picker (tests): it gets the items and returns the picked ones.
function M.record(buf, choose, cb)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  local rel = tests.rel(buf)
  if not rel or not lsp.is_test(buf) then
    vim.notify("rung: open a test file under tests/ (….test.yaml)", vim.log.levels.WARN)
    return
  end
  if vim.bo[buf].modified then
    vim.api.nvim_buf_call(buf, function() vim.cmd("silent write") end)
    vim.notify("rung: saved " .. vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":t") .. ": the case runs from the file")
  end
  local file, why = lsp.request(buf, "rung/testModel", { textDocument = { uri = vim.uri_from_bufnr(buf) } })
  if not file then
    vim.notify("rung: " .. tostring(why), vim.log.levels.WARN)
    return
  end
  local line = vim.api.nvim_buf_call(buf, function() return vim.api.nvim_win_get_cursor(0)[1] - 1 end)
  local case, step, into = target(file.model, line)
  if not case then
    vim.notify("rung: " .. step, vim.log.levels.WARN)
    return
  end
  cli.capture({ "test", "--json", "--observe", "--case", rel .. "#" .. case.index }, {}, function(r)
    local results, err = cli.json(r)
    local c = results and results.files and results.files[1] and results.files[1].cases and results.files[1].cases[1]
    local values, statics = nil, {}
    for _, o in ipairs(c and c.observed or {}) do
      if o.step == step.index + 1 then
        values = o.values
        for _, s in ipairs(o.statics or {}) do statics[s] = true end
      end
    end
    if not values then
      local reason = err or (results and results.files[1] and results.files[1].error) or (c and c.error) or "the case did not get there"
      vim.notify(("rung: no values after step %d: %s"):format(step.index + 1, reason), vim.log.levels.WARN)
      return cb and cb(false)
    end
    local expected = {}
    for _, e in ipairs(into.expect and into.expect.entries or {}) do expected[e.key:upper()] = e.text end
    local items = {}
    for key, v in pairs(values) do
      local now = expected[key:upper()]
      -- statics are the block's memory, not its results: offered, not picked
      local on = now ~= nil and now ~= shown(v) or (now == nil and not statics[key])
      local note = now and (now == shown(v) and "expected already" or ("expected now: " .. now)) or (statics[key] and "static" or nil)
      table.insert(items, { key = key, value = shown(v), on = on, note = note })
    end
    table.sort(items, function(a, b) return a.key < b.key end)
    if #items == 0 then
      vim.notify("rung: the block has no outputs or statics with plain values", vim.log.levels.INFO)
      return cb and cb(false)
    end
    local function finish(picked)
      if not picked or #picked == 0 then return cb and cb(false) end
      local ok, problem = M.write(buf, case, into, picked)
      if not ok then vim.notify("rung: " .. problem, vim.log.levels.WARN) end
      if cb then cb(ok) end
    end
    if choose then return finish(choose(items)) end
    pick(("expect after step %d of %s"):format(step.index + 1, case.name and case.name.value or ("case " .. (case.index + 1))), items, finish)
  end)
end

return M
