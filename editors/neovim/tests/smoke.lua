-- SPDX-License-Identifier: MIT
-- Headless check of rung.nvim against a copy of examples/conveyor (no TIA Portal needed):
--   nvim --headless --clean -l tests/smoke.lua            (from editors/neovim; RUNG_CMD="node <repo>/packages/cli/dist/index.js")
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p"))))
local repo = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(here)
vim.cmd("filetype on")

local failures = 0
local function check(name, ok, detail)
  print((ok and "ok   " or "FAIL ") .. name .. ((not ok and detail) and (": " .. vim.inspect(detail)) or ""))
  if not ok then failures = failures + 1 end
end
local function wait(what, cond, ms)
  local ok = vim.wait(ms or 30000, cond, 50)
  if not ok then check("waiting for " .. what, false) end
  return ok
end

-- the example in a scratch folder
local ws = vim.fs.normalize(vim.fn.tempname())
vim.fn.mkdir(ws .. "/blocks", "p")
vim.fn.mkdir(ws .. "/tests", "p")
for _, f in ipairs({ "blocks/FB_Conveyor.scl", "tests/conveyor.test.yaml" }) do
  vim.fn.writefile(vim.fn.readfile(repo .. "/examples/conveyor/" .. f, "b"), ws .. "/" .. f, "b")
end
vim.fn.chdir(ws)

local cmd = vim.env.RUNG_CMD and vim.split(vim.env.RUNG_CMD, " ", { trimempty = true }) or { "node", repo .. "/packages/cli/dist/index.js" }
require("rung").setup({ cmd = cmd })

-- :Rung is there, with completion
check(":Rung exists", vim.fn.exists(":Rung") == 2)
check("completion", vim.tbl_contains(vim.fn.getcompletion("Rung te", "cmdline"), "test"))

-- cases and the case under the cursor
vim.cmd("edit tests/conveyor.test.yaml")
local buf = vim.api.nvim_get_current_buf()
local tests = require("rung.tests")
local cases = tests.cases(buf)
check("five cases", #cases == 5, #cases)
check("case at the cursor", tests.case_at_cursor(buf, cases[2].line + 2) == 1 and tests.case_at_cursor(buf, 0) == nil)
check("path as rung names it", tests.rel(buf) == "tests/conveyor.test.yaml", tests.rel(buf))

-- a passing case: no diagnostics, a mark on its name
vim.api.nvim_win_set_cursor(0, { cases[1].line + 1, 0 })
local done
tests.run("case", buf, function(r) done = r or false end)
wait("rung test", function() return done ~= nil end)
check("case passed", done and done.files[1].cases[1].passed, done)
check("no diagnostics", #vim.diagnostic.get(buf, { namespace = tests.ns }) == 0)
check("passed mark", #vim.api.nvim_buf_get_extmarks(buf, tests.ns, 0, -1, {}) == 1)

-- a failing expectation: a diagnostic on its step's line and a quickfix entry
local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
for i, l in ipairs(lines) do
  if l:find("expect: { Motor: true, Fault: false }", 1, true) then
    lines[i] = l:gsub("Motor: true", "Motor: false")
    break
  end
end
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
done = nil
tests.run("case", buf, function(r) done = r or false end)
wait("rung test (failing)", function() return done ~= nil end)
local d = vim.diagnostic.get(buf, { namespace = tests.ns })
check("failure on its line", #d == 1 and d[1].lnum == 9 and d[1].message:find("Motor expected false, got true", 1, true) ~= nil, d)
check("quickfix", #vim.fn.getqflist() == 1)
vim.cmd("silent! undo | silent write")

-- coverage: signs on the SCL lines
local cov = require("rung.coverage")
local files
cov.toggle(function(f) files = f or false end)
wait("coverage", function() return files ~= nil end, 60000)
vim.cmd("edit blocks/FB_Conveyor.scl")
local marks = vim.api.nvim_buf_get_extmarks(0, cov.ns, 0, -1, { details = true })
check("coverage signs", #marks > 5, #marks)
check("covered lines green", vim.iter(marks):any(function(m) return m[4].sign_hl_group == "RungCovered" end))
cov.toggle()
check("coverage off", #vim.api.nvim_buf_get_extmarks(0, cov.ns, 0, -1, {}) == 0)

-- record expectations through the language server
vim.fn.writefile({ "block: FB_Conveyor", "cases:", "  - name: recorded", "    steps:", "      - set: { Stop: true, EStopOk: true, Start: true }", "      - cycle: 1" }, ws .. "/tests/rec.test.yaml")
vim.cmd("edit tests/rec.test.yaml")
local rec = vim.api.nvim_get_current_buf()
if wait("language server on the test file", function() return require("rung.lsp").client(rec) ~= nil end, 60000) then
  wait("test model", function() return (require("rung.lsp").request(rec, "rung/testModel", { textDocument = { uri = vim.uri_from_bufnr(rec) } })) ~= nil end, 30000)
  vim.api.nvim_win_set_cursor(0, { 6, 8 })
  local offered, ok
  require("rung.record").record(rec, function(items)
    offered = items
    return vim.tbl_filter(function(i) return i.key == "Motor" or i.key == "Fault" end, items)
  end, function(r) ok = r end)
  wait("record", function() return ok ~= nil end)
  check("values offered", offered and #offered >= 2, offered)
  local text = table.concat(vim.api.nvim_buf_get_lines(rec, 0, -1, false), "\n")
  check("expectations written", ok and text:find("      %- cycle: 1\n        expect: { Fault: false, Motor: true }") ~= nil, text)
  vim.cmd("silent write")
  done = nil
  tests.run("case", rec, function(r) done = r or false end)
  wait("recorded case runs", function() return done ~= nil end)
  check("recorded case passes", done and done.files[1].cases[1].passed, done)
end

-- the debugger's configuration
local conf = require("rung.dap").configuration("x.test.yaml", 2)
check("dap configuration", conf.type == "rung" and conf.case == 2 and conf.stopOnEntry)

print(failures == 0 and "all passed" or (failures .. " failed"))
vim.cmd(failures == 0 and "qa!" or "cq!")
