# AI agents

rung gives agents two things: the TIA Portal project as plain files (read and edit them directly) and a small MCP server for actions (`rung mcp`).

## Claude Code

```
/plugin marketplace add C:/path/to/rung/agents
/plugin install rung@rung
```

The plugin registers the `rung` MCP server and adds `/rung-status` and the skills: `rung-workflow`, `rung-safety`, `rung-review`, `plc-engineer`, `scl-craft`, `lad-in-text`, `plc-data-design`, `plc-testing`, `plc-commissioning` and `iec-st-portable` (TwinCAT and CODESYS). Without the plugin:

```
claude mcp add rung -- rung mcp
```

`rung setup` adds the MCP server and copies the skills for every agent it finds on the PC (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot), so the steps below are for doing it by hand.

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
| `rung_compile` | compile objects (addresses or file paths) in TIA Portal |
| `rung_explain` | an object's file, interface, status and users |
| `rung_find_usages`, `rung_graph` | usages, callers/callees, impact, dependency paths |
| `rung_assignments` | the assignment list: inputs, outputs, bit memory, timers and counters in use, overlaps |
| `rung_diff` | file vs. last synced TIA version |
| `rung_list` | objects by status or folder |
| `rung_rename` | rename in TIA Portal; the files that use it follow |
| `rung_resolve`, `rung_confirm_delete` | conflict resolution, confirmed deletes |
| `rung_test` | the unit tests on the offline simulator |
| `rung_compare`, `rung_live_read` | the project against the PLC, live values (both read-only) |
| `rung_check` | what is installed on the PC |
| `rung_rules`, `rung_download_request` | safety rules; a download request for the person (the MCP server never downloads) |

Every workspace also gets an `AGENTS.md` (regenerate with `rung agents`). Started outside a workspace, `rung mcp` still answers `rung_check`, `rung_test` and the code tools; the others say how a person binds the folder (`rung init`).

rung's tools and agent instructions never download; a person starts every download. An agent that runs shell commands as you is trusted as you are: where a PLC must stay out of its reach, set `download.enabled = false` in its workspace and run it as a Windows user outside the "Siemens TIA Openness" group ([downloads](../downloads.md)).
