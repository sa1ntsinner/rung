-- SPDX-License-Identifier: MIT
-- Headless check of the neotest adapter (needs clones of nvim-neotest/neotest, nvim-lua/plenary.nvim and
-- nvim-neotest/nvim-nio side by side in NEOTEST_DEPS):
--   NEOTEST_DEPS=<folder> nvim --headless --clean -l tests/neotest.lua      (from editors/neovim)
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p"))))
local repo = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(here)
if not vim.env.NEOTEST_DEPS then
  print("skipped: set NEOTEST_DEPS to a folder with neotest, plenary.nvim and nvim-nio")
  vim.cmd("qa!")
end
for _, d in ipairs({ "neotest", "plenary.nvim", "nvim-nio" }) do vim.opt.rtp:prepend(vim.env.NEOTEST_DEPS .. "/" .. d) end

local failures = 0
local function check(name, ok, detail)
  print((ok and "ok   " or "FAIL ") .. name .. ((not ok and detail) and (": " .. vim.inspect(detail)) or ""))
  if not ok then failures = failures + 1 end
end

local ws = vim.fs.normalize(vim.fn.tempname())
vim.fn.mkdir(ws .. "/blocks", "p")
vim.fn.mkdir(ws .. "/tests", "p")
for _, f in ipairs({ "blocks/FB_Conveyor.scl", "tests/conveyor.test.yaml" }) do
  vim.fn.writefile(vim.fn.readfile(repo .. "/examples/conveyor/" .. f, "b"), ws .. "/" .. f, "b")
end
vim.fn.writefile({ "block: FB_Conveyor", "cases:", "  - name: wrong on purpose", "    steps:", "      - set: { Stop: true, EStopOk: true, Start: true }", "      - cycle: 1", "        expect: { Motor: false }" }, ws .. "/tests/wrong.test.yaml")
vim.fn.writefile({ "block: FB_Conveyor", "cases:", "  - steps:", "      - cycle: 1", "    name: first", "  - name: 'second } brace'", "    steps:", "      - cycle: 1" }, ws .. "/tests/order.test.yaml")
require("rung").setup({ cmd = { "node", repo .. "/packages/cli/dist/index.js" } })
local adapter = require("neotest-rung")

--- Runs a spec as neotest's integrated strategy would: the output in a file.
local function run(spec)
  local r = vim.system(spec.command, { cwd = spec.cwd, text = true }):wait()
  local out = vim.fn.tempname()
  vim.fn.writefile(vim.split((r.stdout or "") .. (r.stderr or ""), "\n"), out)
  return { code = r.code, output = out }
end

local done = false
require("nio").run(function()
  local file = ws .. "/tests/conveyor.test.yaml"
  check("root", vim.fs.normalize(adapter.root(ws .. "/tests") or "") == ws, adapter.root(ws .. "/tests"))
  check("test files", adapter.is_test_file(file) and not adapter.is_test_file(ws .. "/blocks/FB_Conveyor.scl") and not adapter.filter_dir("plc"))
  local tree = adapter.discover_positions(file)
  local kinds = {}
  for _, n in tree:iter_nodes() do table.insert(kinds, n:data().type) end
  check("a file and its cases", kinds[1] == "file" and #kinds == 6 and kinds[2] == "test", kinds)

  -- one case: --case tests/conveyor.test.yaml#1
  local second = tree:children()[2]
  local spec = adapter.build_spec({ tree = second })
  check("one case runs by --case", vim.tbl_contains(spec.command, "tests/conveyor.test.yaml#1"), spec.command)
  local results = adapter.results(spec, run(spec), second)
  check("the case passes", results[second:data().id] and results[second:data().id].status == "passed", results)

  -- a whole file with a failing case: the error on its step's line
  local wrong = adapter.discover_positions(ws .. "/tests/wrong.test.yaml")
  local wspec = adapter.build_spec({ tree = wrong })
  local wres = adapter.results(wspec, run(wspec), wrong)
  local case = wres[ws .. "/tests/wrong.test.yaml::0"]
  check("a failing case", case and case.status == "failed" and case.errors[1].message:find("Motor expected false, got true", 1, true) ~= nil and case.errors[1].line == 5, case) -- the step's line (from 0)
  check("its file fails", wres[ws .. "/tests/wrong.test.yaml"].status == "failed", wres)

  -- a case whose name is not its first key keeps its place; braces inside a case name do not break the answer
  local order = adapter.discover_positions(ws .. "/tests/order.test.yaml")
  local names = {}
  for _, n in order:iter_nodes() do if n:data().type == "test" then table.insert(names, n:data().name .. "@" .. n:data().id:match("::(%d+)$")) end end
  check("cases in their places", names[1] == "first@0" and names[2] == "second } brace@1", names)
  local ospec = adapter.build_spec({ tree = order })
  local ores = adapter.results(ospec, run(ospec), order)
  local second_case = ores[ws .. "/tests/order.test.yaml::1"]
  check("a name with a brace", second_case and second_case.status == "passed", ores)
  done = true
end)
vim.wait(120000, function() return done end, 50)
check("finished", done)

print(failures == 0 and "all passed" or (failures .. " failed"))
vim.cmd(failures == 0 and "qa!" or "cq!")
