-- SPDX-License-Identifier: MIT
-- :checkhealth rung
local M = {}

function M.check()
  local h = vim.health
  h.start("rung")
  local cli = require("rung.cli")
  local ok, r = pcall(function() return vim.system(cli.argv({ "--version" }), { text = true }):wait() end)
  if not ok or r.code ~= 0 then
    h.error("rung does not run: " .. table.concat(require("rung").config.cmd, " "), { "Put rung on PATH (the release folder, npm install -g @rung-plc/cli, or VS Code's \"rung: Put rung on PATH\"), or set cmd in require(\"rung\").setup()" })
    return
  end
  h.ok(vim.trim(r.stdout))
  local root = cli.root()
  if root then h.ok("workspace: " .. root) else h.info("no rung.toml at or above " .. vim.fn.getcwd()) end
  if #vim.lsp.get_clients({ name = "rung" }) > 0 then h.ok("language server running") else h.info("language server not started yet (open an .scl file)") end
  if pcall(require, "dap") then h.ok("nvim-dap found: :Rung debug debugs the test case under the cursor") else h.info("nvim-dap not installed: :Rung debug needs it") end
  local check = cli.capture({ "check", "--json" }, { cwd = root })
  local decoded, items = pcall(vim.json.decode, check.stdout or "")
  ok = decoded
  if ok and type(items) == "table" then
    for _, it in ipairs(items) do
      if type(it) == "table" and it.name then
        local f = it.status == "ok" and h.ok or it.status == "warn" and h.warn or it.status == "missing" and h.warn or it.status == "error" and h.error or h.info
        f(it.name .. (it.detail and (": " .. it.detail) or "") .. (it.status ~= "ok" and it.enables and (" (" .. it.enables .. ")") or ""))
      end
    end
  end
end

return M
