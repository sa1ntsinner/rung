# Changelog

## 0.1.0 — 2026-10-03 (pre-release)

The first public release. TIA Portal V20 on Windows; the language server, `rung test` and the MCP server also run on Linux and macOS (the bridge then runs on a Windows PC over ssh).

**Sync**
- `rung init`, `rung pull`, `rung watch`, `rung sync`: a TIA Portal project and a folder of text files kept in sync both ways, one file per object (SCL, STL, DBs, UDTs, LAD/FBD as SIMATIC SD text or SimaticML, tag tables as text, watch tables, network settings). Software units are folders.
- Writes into the project are off until `rung writes on`; `rung sync --preview` shows what would be sent and brought in, line by line. TIA Portal archives the project before the first write of each day.
- Both sides changed: a three-way merge, SCL by line, LAD and FBD by network; the same line on both sides is a conflict you resolve with `rung resolve`.
- Deleting a file deletes nothing until `rung confirm-delete` (a block other blocks use needs `--force`); `rung restore` takes TIA Portal's version of one file back; `rung rename` renames in TIA Portal and the files that use it follow.
- What is sent compiles at once, with its users when its interface changed; TIA Portal's messages land on their line.
- `rung download`, `rung compare`, `rung online`, `rung connect`: a person-started download (the PLC name is typed to confirm), a read-only comparison with the PLC.

**Editors**
- A language server for VS Code, Zed and Neovim: completion, signature help, hover, definition and references through DBs, UDTs, instances and named arguments, rename of variables across the calls that use them, who writes and who reads a tag, a DB member or an address (followed into the blocks it is handed to), errors while typing with TIA Portal's quick fixes, live values from the PLC's Web API.
- VS Code extension: sidebar with the project and the PLC, Testing view, Preview Sync, Who Writes This, Monitor Values, downloads with confirmation. Zed extension with tasks and snippets.

**Tests**
- `rung test`: YAML unit tests for SCL, LAD, FBD, STL and IEC structured text on an offline simulator with virtual time; JUnit and GitHub annotations; checked against CODESYS's simulation on a conformance corpus.

**Agents**
- `rung mcp` and `rung setup`: rung's tools and PLC engineering skills for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot and Zed. Agents never turn writes on and never download.

**Also**
- CODESYS projects through CODESYS without window; TwinCAT and CODESYS structured text in the language server and the simulator.
- `rung assignments`, `rung views`, `rung who`, `rung check`, `rung simulate`.
- A demo project to try it on: `tools/demo/New-DemoProject.ps1`.
