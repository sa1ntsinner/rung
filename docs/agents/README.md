# AI agents

rung gives agents two things: the TIA Portal project as plain files (read and edit them directly) and a small MCP server for actions (`rung mcp`).

## Claude Code

```
/plugin marketplace add C:/path/to/rung/agents
/plugin install rung@rung
```

The plugin registers the `rung` MCP server and adds skills: `rung-workflow`, `rung-safety`, `rung-review`, plus `/rung-status`. Without the plugin:

```
claude mcp add rung -- rung mcp
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.rung]
command = "rung"
args = ["mcp"]
```

## Cursor / Windsurf / VS Code agents

`.cursor/mcp.json` (or the editor's MCP settings):

```json
{ "mcpServers": { "rung": { "command": "rung", "args": ["mcp"] } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `rung_status` | conflicts, pending deletes, recovery items, watcher state |
| `rung_sync` | one two-way pass: import edits, export TIA changes, compile |
| `rung_diagnostics` | SCL checks + TIA compile errors per file |
| `rung_compile` | compile objects in TIA Portal |
| `rung_explain` | an object's file, interface, status and users |
| `rung_find_usages`, `rung_graph` | usages, callers/callees, impact, dependency paths |
| `rung_diff` | file vs. last synced TIA version |
| `rung_list` | objects by status or folder |
| `rung_resolve`, `rung_confirm_delete` | conflict resolution, confirmed deletes |
| `rung_rules`, `rung_download_request` | safety rules; download instructions for the human (rung never downloads) |

Every workspace also gets an `AGENTS.md` (regenerate with `rung agents`).
