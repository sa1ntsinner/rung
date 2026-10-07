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
  local width = 10
  for _, n in ipairs(M.names) do width = math.max(width, #n) end
  for _, n in ipairs(M.names) do
    local s = M.seen[n]
    local text
    if not s then text = "…"
    elseif s.error then text = "! " .. s.error
    else
      local age = now - s.at
      text = shown(s.value) .. "  " .. M.sparkline(s.history) .. (age > 2000 and ("  · %d s old"):format(math.floor(age / 1000)) or "")
    end
    table.insert(out, ("  %-" .. width .. "s  %s"):format(n, text))
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
  if M.job then pcall(vim.fn.jobstop, M.job) end
  M.job = nil
  if M.timer then M.timer:stop(); M.timer:close(); M.timer = nil end
end

local function start()
  stop()
  if not (M.buf and vim.api.nvim_buf_is_valid(M.buf)) or #M.names == 0 then return render() end
  if not cli.available() then return end
  local args = vim.list_extend({ "live", "watch" }, vim.deepcopy(M.names))
  vim.list_extend(args, { "--json", "--interval", "500" })
  local partial, err = "", {}
  M.job = vim.fn.jobstart(cli.argv(args), {
    cwd = cli.root(),
    on_stdout = function(_, data)
      data[1] = partial .. data[1]
      partial = table.remove(data)
      for _, line in ipairs(data) do
        local ok, m = pcall(vim.json.decode, line)
        if ok and type(m) == "table" and m.at then
          for _, n in ipairs(M.names) do
            local s = M.seen[n] or { history = {} }
            if m.errors and m.errors[n] then s.error = m.errors[n]
            elseif m.values and m.values[n] ~= nil then
              s.error, s.value = nil, m.values[n]
              table.insert(s.history, s.value)
              if #s.history > 32 then table.remove(s.history, 1) end
            end
            s.at = vim.uv.now()
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
  if rest[1] == "add" then return M.add(table.concat(vim.list_slice(rest, 2), " ")) end
  if rest[1] == "remove" then return M.remove(table.concat(vim.list_slice(rest, 2), " ")) end
  M.toggle()
end

return M
