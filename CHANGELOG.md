# Changelog

## Unreleased

**Debugging and testing**
- Debug a test case (*Debug Test* in the test explorer): breakpoints in SCL blocks, with conditions; step over, into and out of calls (out of the tested block: on to its next cycle); **step back** and reverse continue; the block's variables and data blocks, values set while stopped (checked like a test's `set:`), expressions in the Debug Console, values next to the code. A failing case stops where its failed expectation's values are, or at the statement that raised an error. `rung debug` is the Debug Adapter Protocol server behind it, for nvim-dap and other editors.
- **Why?** while stopped: the statement that last wrote a value (found by where the value lives, so an instance DB and `#x` inside the FB are the same), the values its operands had just before it ran, each explained in turn, and the IF or CASE branch that made it run.
- *Run with Coverage* and `rung test --coverage lcov.info`: which SCL lines the tests reached, in the editor and as lcov for CI.
- *Record Expectations*: run the case, pick the block's values after a step, they become its `expect:` (`rung test --json --observe` for scripts).
- Temporal expectations: `{ within: 2s, expect: … }`, `always`, `never`, with when a promise broke.
- `rung test --against <git revision>`: today's tests on the code then and now; every case that behaves differently, with the first value that differs.

**Editor**
- Format Document writes SCL code as TIA Portal does (its indents, capitals, spacing, a call's parameters one per line), so a sync and a pull bring the file back unchanged; the rules were taken from TIA Portal V19 and V20 round trips. `rung format [--check]` for CI.
- Assignments and call arguments between elementary types are judged as TIA Portal V20 judges them: TIA Portal's own answers for all pairs of 24 types (refused, or a warning that the sign or accuracy may be lost).
- Mistakes TIA Portal compiles without a word: a temporary read before the block writes it, an FC output never written, a function that never sets its return value (TIA Portal's compile error, shown while typing), temporaries and constants nobody uses (faded). `// rung-ignore` silences one.
- Semantic highlighting: inputs, outputs, statics, temporaries, constants, DBs, blocks, tags and types read differently. Call hierarchy of a block (instance DBs and multi-instances included).
- The status bar says what the watch is doing in one phrase (`FB_Motor → TIA`, `compiling in TIA`, `2 compile errors`, `1 conflict`, `waiting for TIA Portal (a dialog may be open)`); the Activity view keeps a day's sends, compiles, refusals and errors, also for an editor opened after the watch started.
- The Changes view lists what a sync would send and bring before it runs (a sync runs only on the plan you looked at), conflicts open in VS Code's merge editor, and PLC comparisons stay there.
- A download's outcome says what is known about the PLC: nothing downloaded, reached the PLC (the CPU may be in STOP), or unknown, with *Compare with PLC*.
- Live Values: pin PLC tags and DB members in the rung sidebar; they are read twice a second while the view is open, each with its age and a short history line (`rung live watch <names> --json`, read-only).
- TIA Portal's cross-reference of a block: `rung xref`, VS Code *Cross-Reference in TIA Portal*, Neovim `:Rung xref`, MCP `rung_xref` (who uses it, HMI screens and alarms included).
- Neovim: rung.nvim (`editors/neovim`) with `:Rung` commands, tests as diagnostics on their steps, coverage signs, recorded expectations, the debugger through nvim-dap and `:Rung why`.

**TIA Portal versions**
- TIA Portal V19 (pull, sync and compile tested; blocks that would be SIMATIC SD stay SimaticML in V19). V21 builds and opens projects. `rung init` picks the version from the project file; `rung setup openness` registers the bridge of every installed version.

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
