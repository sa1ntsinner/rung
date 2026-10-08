-- SPDX-License-Identifier: MIT
-- :Rung <command>. What talks to TIA Portal or a PLC runs in a terminal split, where rung's questions (a download's
-- typed PLC name, TIA's questions) are answered by a person.
local cli = require("rung.cli")
local M = {}

local terminal = function(args) return function(rest) cli.terminal(vim.list_extend(args, rest)) end end

M.commands = {
  status = terminal({ "status" }),
  pull = terminal({ "pull" }),
  sync = terminal({ "sync" }),
  preview = terminal({ "sync", "--preview" }),
  watch = function(rest) cli.terminal(vim.list_extend({ "watch" }, rest), { height = 8 }) end,
  compile = terminal({ "compile" }),
  compare = terminal({ "compare" }),
  online = terminal({ "online", "--state" }),
  -- rung download asks for the PLC's name itself; nothing here answers for the person
  download = terminal({ "download" }),
  check = terminal({ "check" }),
  test = function(rest) require("rung.tests").run(rest[1] == "file" and "file" or "case") end,
  ["test-all"] = terminal({ "test" }),
  record = function() require("rung.record").record() end,
  coverage = function() require("rung.coverage").toggle() end,
  debug = function() require("rung.dap").debug_case() end,
  why = function(rest) require("rung.why").ask(rest[1]) end,
  xref = function() require("rung.xref").show() end,
  live = function(rest) require("rung.live").command(rest) end,
}

function M.setup(cfg)
  vim.api.nvim_create_user_command("Rung", function(o)
    local name = o.fargs[1] or "status"
    local run = M.commands[name]
    if not run then
      vim.notify("rung: no command " .. name .. " (" .. table.concat(vim.tbl_keys(M.commands), ", ") .. ")", vim.log.levels.WARN)
      return
    end
    run(vim.list_slice(o.fargs, 2))
  end, {
    nargs = "*",
    desc = "rung: TIA Portal as code",
    complete = function(lead, line)
      if #vim.split(line, "%s+") > 2 then return {} end
      local names = vim.tbl_keys(M.commands)
      table.sort(names)
      return vim.tbl_filter(function(n) return n:find(lead, 1, true) == 1 end, names)
    end,
  })
  if cfg.test_on_save then
    vim.api.nvim_create_autocmd("BufWritePost", {
      group = vim.api.nvim_create_augroup("rung.test_on_save", { clear = true }),
      pattern = { "*.test.yaml", "*.test.yml" },
      callback = function() require("rung.tests").run("case") end,
    })
  end
end

return M
