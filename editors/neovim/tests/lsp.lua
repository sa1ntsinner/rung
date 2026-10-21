-- SPDX-License-Identifier: MIT
local here = vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p"))))
vim.opt.rtp:prepend(here)
local lsp = require("rung.lsp")
local answer, cancelled, done
lsp.client = function() return {
  request = function(_, _, _, cb) answer = cb; return true, 42 end,
  request_sync = function() error("request_sync blocks the editor") end,
  cancel_request = function(_, id) cancelled = id end,
} end
lsp.request(0, "rung/testModel", {}, function(result, why) done = result or why end, 100)
assert(done == nil, "must return before the server answers")
answer(nil, { model = true })
assert(done.model, "callback gets the result")
done = nil
lsp.request(0, "rung/testModel", {}, function(result, why) done = result or why end, 100)
answer({ message = "failed" }, { stale = true })
assert(done == "failed", "server errors do not return a result")
done = nil
lsp.request(0, "rung/testModel", {}, function(result, why) done = result or why end, 10)
assert(vim.wait(1000, function() return done ~= nil end, 5))
assert(cancelled == 42 and done:find("did not answer"), "timeout cancels the request")
done = nil
lsp.request(0, "rung/testModel", {}, function(result, why) done = result or why end, 100)
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "changed" })
answer(nil, { stale = true })
assert(type(done) == "string" and done:find("changed"), "edited buffer refuses stale results")
print("all passed")
vim.cmd("qa!")
