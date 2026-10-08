-- SPDX-License-Identifier: MIT
-- The rung language server for SCL files and for tests/**/*.test.yaml (completion of names, rename that
-- follows into tests, and the edits behind recorded expectations).
local M = {}

local function is_test(buf)
  return vim.api.nvim_buf_get_name(buf):gsub("\\", "/"):match("/tests/.+%.test%.ya?ml$") ~= nil
end

function M.setup(cfg)
  vim.filetype.add({ extension = { scl = "scl", db = "scl", udt = "scl", s7dcl = "s7dcl" } })
  vim.lsp.config("rung", {
    cmd = require("rung.cli").argv({ "lsp", "--stdio" }),
    cmd_env = cfg.lsp_env,
    filetypes = { "scl", "s7dcl", "yaml" },
    -- a YAML file is the server's only when it is a test of the workspace
    root_dir = function(buf, done)
      if vim.bo[buf].filetype == "yaml" and not is_test(buf) then return end
      local root = vim.fs.root(buf, require("rung.cli").markers)
      if root then done(root) end
    end,
  })
  vim.lsp.enable("rung")
end

--- The rung client attached to a buffer, if any.
function M.client(buf)
  return vim.lsp.get_clients({ bufnr = buf or 0, name = "rung" })[1]
end

--- A request to the rung server for a buffer, waited for (nil and why on failure).
function M.request(buf, method, params, timeout)
  local client = M.client(buf)
  if not client then return nil, "the rung language server is not attached to this buffer" end
  local r = client:request_sync(method, params, timeout or 10000, buf)
  if not r then return nil, "the rung language server did not answer" end
  if r.err then return nil, r.err.message end
  return r.result
end

M.is_test = is_test
return M
