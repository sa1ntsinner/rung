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

--- Request without blocking the editor; callback receives result or nil and why.
function M.request(buf, method, params, cb, timeout)
  buf = (buf == nil or buf == 0) and vim.api.nvim_get_current_buf() or buf
  local client = M.client(buf)
  if not client then return cb(nil, "the rung language server is not attached to this buffer") end
  local tick, name = vim.api.nvim_buf_get_changedtick(buf), vim.api.nvim_buf_get_name(buf)
  local finished = false
  local function finish(err, result)
    if finished then return end
    finished = true
    if not vim.api.nvim_buf_is_valid(buf) or vim.api.nvim_buf_get_name(buf) ~= name or vim.api.nvim_buf_get_changedtick(buf) ~= tick then
      return cb(nil, "the buffer changed while waiting for the language server")
    end
    if err then return cb(nil, err.message) end
    cb(result)
  end
  local sent, id = client:request(method, params, finish, buf)
  if not sent then return finish({ message = "the rung language server did not accept the request" }) end
  vim.defer_fn(function()
    if finished then return end
    client:cancel_request(id)
    finish({ message = "the rung language server did not answer" })
  end, timeout or 10000)
  return id
end

M.is_test = is_test
return M
