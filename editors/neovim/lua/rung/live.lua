-- SPDX-License-Identifier: MIT
-- :Rung live: values pinned from the PLC (its Web API, or rung simulate) in a split at the bottom, read twice a
-- second while the split is open, each with its age and a short history (`rung live watch <names> --json`,
-- read-only). :Rung live add "DB".x pins one (the word under the cursor without a name), :Rung live remove unpins.
local cli = require("rung.cli")
local M = { names = {}, seen = {} }

local BARS = { "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" }

--- The last values as a little line (numbers scaled, booleans low/high); "" when it cannot be drawn.
function M.sparkline(history)
  local xs = {}
  for i = math.max(1, #history - 15), #history do
    local v = history[i]
    if type(v) == "boolean" then table.insert(xs, v and 1 or 0)
    elseif type(v) == "number" then table.insert(xs, v)
    else return "" end
  end
  if #xs < 2 then return "" end
  local lo, hi = math.min(unpack(xs)), math.max(unpack(xs))
  local out = {}
  for _, x in ipairs(xs) do table.insert(out, BARS[hi == lo and 1 or (math.floor((x - lo) / (hi - lo) * 7 + 0.5) + 1)]) end
  return table.concat(out)
end

local function shown(v)
  if type(v) == "boolean" then return v and "TRUE" or "FALSE" end
  if type(v) == "string" then return "'" .. v .. "'" end
  return vim.json.encode(v)
end

local function lines()
  if #M.names == 0 then return { "  nothing pinned: :Rung live add \"DB\".member" } end
  local out, now = {}, vim.uv.now()
  if M.table then table.insert(out, "  " .. M.table.name) end
  local width = 10
  for _, n in ipairs(M.names) do width = math.max(width, #(M.labels and M.labels[n] or n)) end
  for _, n in ipairs(M.names) do
    local s = M.seen[n]
    local text
    if not s then text = "…"
    elseif s.error then text = "! " .. s.error
    else
      local age = now - s.at
      text = shown(s.value) .. "  " .. M.sparkline(s.history) .. (age > 2000 and ("  · %d s old"):format(math.floor(age / 1000)) or "")
    end
    local comment = M.comments and M.comments[n] or ""
    table.insert(out, ("  %-" .. width .. "s  %s%s"):format(M.labels and M.labels[n] or n, text, comment ~= "" and ("  · " .. comment) or ""))
  end
  return out
end

local function render()
  if not (M.buf and vim.api.nvim_buf_is_valid(M.buf)) then return end
  vim.bo[M.buf].modifiable = true
  vim.api.nvim_buf_set_lines(M.buf, 0, -1, false, lines())
  vim.bo[M.buf].modifiable = false
end

local function stop()
  M.generation = (M.generation or 0) + 1
  if M.job then
    local job = M.job
    pcall(vim.fn.chanclose, job, "stdin")
    vim.defer_fn(function()
      if vim.fn.jobwait({ job }, 0)[1] == -1 then pcall(vim.fn.jobstop, job) end
    end, 2000)
  end
  M.job = nil
  if M.timer then M.timer:stop(); M.timer:close(); M.timer = nil end
end

local function start()
  stop()
  if not (M.buf and vim.api.nvim_buf_is_valid(M.buf)) or (#M.names == 0 and not M.tableFile) then return render() end
  if not cli.available() then return end
  local args = vim.list_extend({ "live", "watch" }, M.tableFile and { "--table", M.tableFile } or vim.deepcopy(M.names))
  vim.list_extend(args, { "--json", "--parent-stdio", "--interval", "500" })
  local partial, err = "", {}
  local generation = M.generation
  M.job = vim.fn.jobstart(cli.argv(args), {
    cwd = cli.root(),
    on_stdout = function(_, data)
      if generation ~= M.generation then return end
      data[1] = partial .. data[1]
      partial = table.remove(data)
      for _, line in ipairs(data) do
        local ok, m = pcall(vim.json.decode, line)
        if ok and type(m) == "table" and m.plan and m.plan.table and M.tableFile then
          M.table, M.names, M.labels, M.comments, M.seen = m.plan.table, {}, {}, {}, {}
          for _, row in ipairs(M.table.rows) do
            table.insert(M.names, row.key)
            M.labels[row.key] = (row.name or row.address or row.key):gsub("%c", " ")
            local comments = {}
            for _, text in pairs(row.comments or {}) do table.insert(comments, (text:gsub("%c", " "))) end
            M.comments[row.key] = table.concat(comments, " | ")
            if m.plan.errors and m.plan.errors[row.key] then M.seen[row.key] = { error = m.plan.errors[row.key], history = {}, at = vim.uv.now() } end
          end
          vim.schedule(render)
        end
        if ok and type(m) == "table" and m.at then
          for _, n in ipairs(M.names) do
            local s = M.seen[n] or { history = {} }
            if m.errors and m.errors[n] then s.error = m.errors[n]
            elseif m.values and m.values[n] ~= nil and (not m.observedAt or (m.observedAt[n] and m.observedAt[n] > (s.observedAt or 0))) then
              s.error, s.value = nil, m.values[n]
              s.observedAt = m.observedAt and m.observedAt[n] or m.at
              s.at = vim.uv.now()
              table.insert(s.history, s.value)
              if #s.history > 32 then table.remove(s.history, 1) end
            end
            M.seen[n] = s
          end
          vim.schedule(render)
        end
      end
    end,
    on_stderr = function(_, data) vim.list_extend(err, data) end,
    on_exit = function(_, code)
      if code ~= 0 and code ~= 143 and code ~= 1 then return end
      local why = vim.trim(table.concat(err, "\n"))
      if code ~= 0 and why ~= "" then vim.schedule(function() vim.notify("rung live: " .. why:gsub("^rung live:%s*", ""), vim.log.levels.WARN) end) end
    end,
  })
  -- ages go on while values come in (or stop coming)
  M.timer = vim.uv.new_timer()
  M.timer:start(1000, 1000, vim.schedule_wrap(render))
end

--- Opens (or closes) the split.
function M.toggle()
  if M.win and vim.api.nvim_win_is_valid(M.win) then
    vim.api.nvim_win_close(M.win, true)
    return
  end
  M.buf = vim.api.nvim_create_buf(false, true)
  vim.bo[M.buf].bufhidden = "wipe"
  vim.api.nvim_buf_set_name(M.buf, "rung://live")
  vim.cmd("botright 8split")
  M.win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(M.win, M.buf)
  vim.wo[M.win].number = false
  vim.api.nvim_create_autocmd("BufWipeout", { buffer = M.buf, once = true, callback = stop })
  vim.keymap.set("n", "q", M.toggle, { buffer = M.buf, nowait = true })
  vim.keymap.set("n", "dd", function()
    if M.tableFile then return end
    local n = M.names[vim.api.nvim_win_get_cursor(0)[1]]
    if n then M.remove(n) end
  end, { buffer = M.buf, nowait = true })
  vim.cmd("wincmd p")
  start()
end

function M.add(name)
  name = name and name ~= "" and name or vim.fn.expand("<cWORD>"):gsub("[;,]$", "")
  if name == "" or vim.tbl_contains(M.names, name) then return end
  if name:sub(1, 1) == "#" then
    vim.notify('rung: a block\'s local lives in an instance: pin it through its DB, "Motor_DB".name', vim.log.levels.WARN)
    return
  end
  if M.tableFile then M.tableFile, M.table, M.labels, M.comments, M.names, M.seen = nil, nil, nil, nil, M.pinned or {}, {} end
  table.insert(M.names, name)
  if not (M.win and vim.api.nvim_win_is_valid(M.win)) then M.toggle() else start() end
end

function M.remove(name)
  M.names = vim.tbl_filter(function(n) return n ~= name end, M.names)
  M.seen[name] = nil
  start()
end

--- :Rung live [add <name> | remove <name>]
function M.command(rest)
  if rest[1] == "modify" or rest[1] == "run" or rest[1] == "stop" or rest[1] == "alarms" or rest[1] == "state" or rest[1] == "diag" then
    return cli.terminal(vim.list_extend({ "live" }, rest))
  end
  if rest[1] == "table" then
    local file = table.concat(vim.list_slice(rest, 2), " ")
    if file == "" then file = vim.api.nvim_buf_get_name(0) end
    if not M.tableFile then M.pinned = vim.deepcopy(M.names) end
    M.tableFile, M.names, M.seen = file, {}, {}
    if not (M.win and vim.api.nvim_win_is_valid(M.win)) then M.toggle() else start() end
    return
  end
  if rest[1] == "add" then return M.add(table.concat(vim.list_slice(rest, 2), " ")) end
  if rest[1] == "remove" then return M.remove(table.concat(vim.list_slice(rest, 2), " ")) end
  M.toggle()
end

return M
