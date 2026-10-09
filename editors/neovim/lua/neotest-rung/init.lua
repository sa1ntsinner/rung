-- SPDX-License-Identifier: MIT
-- neotest adapter for rung's unit tests (tests/**/*.test.yaml on the offline simulator):
--   require("neotest").setup({ adapters = { require("neotest-rung") } })
-- A file's cases are its tests; a run is `rung test --json` (one case by --case, a file by --filter), and a failed
-- expectation is an error on its step's line.
local lib = require("neotest.lib")
local tests = require("rung.tests")
local cli = require("rung.cli")

local adapter = { name = "neotest-rung" }

adapter.root = lib.files.match_root_pattern(unpack(cli.markers))

function adapter.filter_dir(name)
  return name ~= "node_modules" and name ~= ".rung" and name ~= ".git" and name ~= "plc"
end

function adapter.is_test_file(path)
  return path:match("%.test%.ya?ml$") ~= nil
end

function adapter.discover_positions(path)
  local lines = lib.files.read_lines(path)
  local cases = tests.cases_of(lines)
  local tree = { { type = "file", path = path, name = vim.fn.fnamemodify(path, ":t"), id = path, range = { 0, 0, #lines, 0 } } }
  for i, c in ipairs(cases) do
    local stop = cases[i + 1] and cases[i + 1].line - 1 or #lines - 1
    table.insert(tree, { { type = "test", path = path, name = c.name, id = path .. "::" .. (i - 1), range = { c.line, 0, stop, 0 } } })
  end
  -- the ids stay rung's (file::case number from 0), which is what --case takes
  return require("neotest.types").Tree.from_list(tree, function(pos) return pos.id end)
end

--- The test file as rung names it from the workspace root: tests/….test.yaml.
local function rel(root, path)
  root, path = vim.fs.normalize(root), vim.fs.normalize(path)
  return path:sub(#root + 2)
end

function adapter.build_spec(args)
  local pos = args.tree:data()
  if pos.type ~= "file" and pos.type ~= "test" then return nil end
  local root = adapter.root(pos.path)
  if not root then return nil end
  local file = rel(root, pos.path)
  local select = pos.type == "test" and { "--case", file .. "#" .. pos.id:match("::(%d+)$") } or { "--filter", file }
  return { command = cli.argv(vim.list_extend({ "test", "--json" }, select)), cwd = root, context = { path = pos.path } }
end

function adapter.results(spec, result, tree)
  local text = lib.files.read(result.output)
  -- the JSON answer; if a shim printed lines around it, from the first line that opens it to the last brace
  local decode = function(s) return pcall(vim.json.decode, s, { luanil = { object = true, array = true } }) end
  local ok, data = decode(text)
  if not ok then
    local from = text:find("\n{") or (text:sub(1, 1) == "{" and 0)
    local to = text:match(".*()}")
    if from and to then ok, data = decode(text:sub(from + 1, to)) end
  end
  local out = {}
  if not ok or type(data) ~= "table" then
    for _, node in tree:iter_nodes() do
      out[node:data().id] = { status = "failed", output = result.output, short = "rung test gave no answer", errors = { { message = vim.trim(text) } } }
    end
    return out
  end
  local path = spec.context.path
  local file_ok = true
  for _, f in ipairs(data.files or {}) do
    if f.error then
      file_ok = false
      out[path] = { status = "failed", output = result.output, errors = { { message = f.error, line = f.errorLine and (f.errorLine - 1) or nil } } }
    end
    for _, c in ipairs(f.cases or {}) do
      local errors = {}
      if c.error then table.insert(errors, { message = (c.errorStep and ("step " .. c.errorStep .. ": ") or "") .. c.error, line = (c.errorLine or c.line or 1) - 1 }) end
      for _, x in ipairs(c.failures or {}) do
        table.insert(errors, { message = ("step %d: %s expected %s, got %s%s"):format(x.step, x.name, vim.json.encode(x.expected), vim.json.encode(x.actual), x.note and (" (" .. x.note .. ")") or ""), line = (x.line or c.line or 1) - 1 })
      end
      if not c.passed then file_ok = false end
      out[path .. "::" .. (c.index or 0)] = { status = c.passed and "passed" or "failed", output = result.output, short = c.name .. (c.passed and ": passed" or ": failed"), errors = errors }
    end
  end
  out[path] = out[path] or { status = file_ok and "passed" or "failed", output = result.output }
  return out
end

return adapter
