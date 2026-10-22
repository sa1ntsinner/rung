# AI agents

rung gives agents two things: the TIA Portal project as plain files (read and edit them directly) and a small MCP server for actions (`rung mcp`).

Without a mode an agent may do on a PLC what the person can. [Agent permission modes](modes.md) let the person restrict that with `manual`, `ask` or `auto` per workspace or PLC. Read-only locks always win.

## Claude Code

```
/plugin marketplace add C:/path/to/rung/agents
/plugin install rung@rung
```

The plugin registers the `rung` MCP server and adds `/rung-status` and the skills: `rung-workflow`, `rung-safety`, `rung-review`, `plc-engineer`, `scl-craft`, `lad-in-text`, `plc-data-design`, `plc-testing`, `plc-commissioning` and `iec-st-portable` (TwinCAT and CODESYS).

Since 0.3.1 it also starts the SCL language server for `.scl`, `.db`, `.udt`, `.s7dcl`, `.awl` and `.st`, so diagnostics arrive after edits. The `plc-reviewer` subagent reads a change and its affected code; `plc-diagnostician` reads online state, alarms and the diagnostic buffer and traces observations to code. Both have explicit lists of read tools and no shell or file editing tools. A PreToolUse hook checks shell commands and configuration edits with `rung guard --claude-hook`.

Install the plugin from the release's `agents` folder. The release includes its CLI and companion hosts inside the plugin, so copying it into Claude Code's cache keeps MCP, LSP and hooks working without a `rung` shell shim. This duplicates the runtime, its licences and corresponding source in the archive; the launcher prefers the original release CLI when it is still beside the plugin. In a source checkout, build rung first. Release packaging sets the plugin version to the CLI version.

The cached runtime's TIA bridge has a different path from the original installation. A person can register it with Openness from their own terminal, or configure the existing whitelisted bridge through `RUNG_BRIDGE` or `bridge.command`. For agents, `rung setup openness` requires permission for the `openness-setup` action. Offline tools and the S7 read backend do not need that Openness registration.

Without the plugin:

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
| `rung_status` | conflicts, pending deletes, recovery items, watcher state, effective agent modes and allowed actions per PLC |
| `rung_sync` | one two-way pass: import edits, export TIA changes, compile |
| `rung_sync_preview` | read-only plan with short unified diffs; show the person before sending |
| `rung_diagnostics` | SCL checks + TIA compile errors per file |
| `rung_compile` | compile objects (addresses or file paths) in TIA Portal |
| `rung_explain` | an object's file, interface, status and users |
| `rung_find_usages`, `rung_graph` | usages, callers/callees, impact, dependency paths |
| `rung_why` | why a variable has its value, from the code: the statements that write it, their branches and operands |
| `rung_impact` | what an interface change breaks against the version TIA Portal has: calls, instance DBs reinitialised on download, tests |
| `rung_xref` | TIA Portal's own cross-reference of an object: who uses it, HMI screens and alarms included (read-only) |
| `rung_assignments` | the assignment list: inputs, outputs, bit memory, timers and counters in use, overlaps |
| `rung_diff` | file vs. last synced TIA version |
| `rung_list` | objects by status or folder |
| `rung_rename` | rename in TIA Portal; the files that use it follow |
| `rung_resolve`, `rung_confirm_delete` | conflict resolution, confirmed deletes |
| `rung_test` | the unit tests on the offline simulator; `observe` adds the block's values after each step, to write expectations from |
| `rung_compare`, `rung_live_read` | the project against the PLC, live values (both read-only) |
| `rung_live_state`, `rung_live_alarms`, `rung_live_diag` | CPU state, paged alarms and diagnostic buffer (read-only) |
| `rung_review` | [offline change report](../review.md): interfaces, regions/networks, callers, data blocks and tags |
| `rung_check` | what is installed on the PC |
| `rung_rules`, `rung_download_request` | safety rules; a download request for the person (the MCP server never downloads) |

All tools publish a title, read/write hints and an output schema. Results keep their text copy and expose the same value in `structuredContent.result`. Deletes and conflict resolution request human interaction on every call in clients supporting `anthropic/requiresUserInteraction`; these hints do not grant write permission.

Lists use `offset`/`limit` (default 50, maximum 100), with `total` and `nextOffset`. Assignment summaries show counts; `summary:false` includes tags and use locations, paged independently with `detailOffset`/`detailLimit`. Sync previews default to five objects and 1,000 diff characters each; `rung_diff` reads larger diffs in character windows. Sending with `rung_sync` returns a link to `rung://sync/0` for further report pages without sending again. The old `rung_sync` `preview` argument is rejected.

Tests return totals and failures by default; `verbose:true` includes passing cases. `observe:true` returns five cases, five steps per case and ten values per step by default. Use case `offset`, `stepOffset`, and `valueOffset` independently to continue. Errors, conflicts and compile errors stay complete even when ordinary details are paged. `rung://graph` is a summary; `rung://graph/{object}` reads one node and its neighbours. Diagnostics resources use `rung://diagnostics/{offset}`. Reviews page blocks with `offset` and their details independently with `detailOffset`; logic excerpts mark truncation explicitly. The CLI Markdown/JSON review contains the full report.

Every workspace also gets an `AGENTS.md` (regenerate with `rung agents`). Started outside a workspace, `rung mcp` still answers `rung_check`, `rung_test` and the code tools; the others say how a person binds the folder (`rung init`).

rung does not decide for you what an agent may do on a PLC. Without a mode, an agent can download, write live values, change RUN/STOP, turn on writes and register Openness, as the person can. Where you want a restriction, choose an [agent permission mode](modes.md) outside the agent (`manual`, `ask` or `auto`); the agent checks it and asks the person when refused. An agent cannot change the mode. Read-only locks always win. A person confirming a PLC change in VS Code can still perform it when the editor inherited an agent environment.

`rung setup` installs hooks for Claude Code (PreToolUse), Cursor (beforeShellExecution) and Copilot (preToolUse) that apply the mode you chose before a command runs; `--dry-run` shows them first. Existing hooks and deny lists are kept. The hooks also stop an agent from editing the external `rung/agent-modes.toml` store or the `read_only` and `allow_writes` lines of `rung.toml`. rung adds no deny rules of its own; any you add in a client stay in force.

The guard recognises `CLAUDECODE`, `CODEX_*`, `CURSOR_*`, `GEMINI_CLI`, `OPENCODE`, Copilot markers, `AI_AGENT` and other agent markers. Agent launchers without a marker should set `RUNG_AGENT=1`. Environment detection and client rules are defence in depth, not a sandbox: markers can be absent or removed, clients can disable hooks, and a program running as your Windows user can call Openness directly. Where a PLC must stay out of an agent's reach, choose `manual`, keep `download.enabled = false` and run the agent as a Windows user outside the "Siemens TIA Openness" group ([downloads](../downloads.md)).
