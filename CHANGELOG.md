# Changelog

## Unreleased

**VS Code**
- Declarations: a block's interface as a table beside the SCL code, with TIA Portal's sections, structures that open into their members, three column presets (Code, HMI access, Commissioning), a filter and an inspector. HMI/OPC UA attributes show TIA Portal's default faint and an explicit setting plainly.
- Declarations are edited in the table: names (a rename the code follows), data types with the PLC's types suggested, default values, comments, HMI/OPC UA attributes with a click or Space (Reset goes back to TIA Portal's default), new declarations with Insert or a section's +, deletion that asks first when the declaration is used. Rows copied from Excel or TIA Portal paste with a preview; Ctrl+C copies a row. Every edit is one text edit of the open file, undone with Ctrl+Z; one made on text that has changed since is refused.
- UDT files open as a table too (Open as Table, or Open With… → UDT Table).
- A type set to `Struct` opens a structure with its first member ready to name; *Add member* adds more. Errors and warnings of the language server underline the cell they are about.
- Usages keeps the earlier questions (the history button in its title).
- *Create test* above a block that has no test yet: a first test file with the block's inputs set, one cycle and its outputs to expect, opened to change the expected values. A test that exists is opened, never written over.
- The test explorer runs a picked case and nothing else.
- *New Object…* (command palette, or + in the Project view): a function block, function, global DB, PLC data type or tag table in a few steps (kind, PLC or software unit, folder, name). The file is written as TIA Portal exports a new object, so the first sync changes nothing back; a name the PLC already has is refused while you type.
- The declarations table shows the sections a block can have and has not yet (a new FB has none): their + makes the section with its first declaration, where TIA Portal puts it.
- Test files open as a table (Open Test as Table, or Open With… → Test Table): the cases on the left, the selected case's steps on the right (Set, Run, Advance, Expect) with each name and value edited in place. Insert adds a name of the block under test (picked from its inputs, outputs and statics, or typed), Delete removes one, Alt+Up/Down moves a step; cases are added, renamed, duplicated and deleted in the list. A name the block does not have is underlined with the closest one. Run a case or all of them: the result shows on the case and on the expectation that failed. Every change is a small text edit of the file in its own style, comments kept.

**CLI**
- `rung test --case tests/x.test.yaml#2` runs exactly one case; `--json` gives each case its `index` in the file.
- Usages: Who Writes This? fills a sidebar view that stays while you open the places it lists.
- Get started: a short walkthrough from checking the PC to the first sync.

**Language server**
- `rung/declarations` and `rung/declarationEdit`: the interface with exact source ranges, and edits that change only their own text, written the way TIA Portal exports them (checked by import, compile and export in TIA Portal V20).
- Declaration edits also set a type, insert and delete declarations (instruction instances such as `TON` are written as TIA Portal writes them, names SCL reserves are quoted) and refuse what TIA Portal would not accept: a default value on a temporary or a function's parameter, a constant without a value, a value that would end the line. `rung/declarationPaste` reads pasted rows (English or German column names); `rung/typeNames` lists the types a declaration can use. `rung/testSkeleton` drafts a block's first test and names the test files it already has. `rung/testModel` and `rung/testEdit` read a test file with exact ranges and plan its edits (flow and block maps, quotes kept, comments kept, CRLF kept).

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
