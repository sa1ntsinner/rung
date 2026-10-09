# Changelog

## Unreleased

**TIA Portal without window**
- *Open TIA Project…* in VS Code checks the local PC or another Windows PC over ssh, mirrors the project and starts watch. Watch starts with a trusted folder by default (`rung.watch.autoStart`). A keeper reuses one background TIA Portal for the project's commands and editors (10 min idle, `RUNG_KEEPER_IDLE_S`); *Open in TIA Portal* moves the project into a window, with *Save and Open* for unsaved changes. `rung session` inspects it without starting TIA Portal; `rung session --release` stops watch and releases the background project. The PLC picker remembers its last choice. `rung connect --address` edits `network.yaml` for V19/V20; V21 uses an online address with the project unchanged. PLC passwords and users come from the CLI environment or VS Code's secret storage. Untrusted TLS certificates require consent for that connection, never remembered. V21 Openness setup writes its `AllowList`. See [Going online](docs/online.md) and the [measurements](docs/evidence.md#tia-portal-without-window-measured).

**Debugging and testing**
- Debug a test case (*Debug Test* in the test explorer): breakpoints in SCL blocks, with conditions; step over, into and out of calls (out of the tested block: on to its next cycle); **step back** and reverse continue; the block's variables and data blocks, values set while stopped (checked like a test's `set:`), expressions in the Debug Console, values next to the code. A failing case stops where its failed expectation's values are, or at the statement that raised an error. `rung debug` is the Debug Adapter Protocol server behind it, for nvim-dap and other editors.
- **Why?** while stopped: the statement that last wrote a value (found by where the value lives, so an instance DB and `#x` inside the FB are the same), the values its operands had just before it ran, each explained in turn, and the IF or CASE branch that made it run.
- Neovim: a neotest adapter (`require("neotest-rung")`: each case of a test file is a test, failures on their step's line) and a statusline part for lualine (`require("rung.status").get`: watch running, conflicts, sync errors).
- Live Values: a flight recorder keeps the last ten minutes of reads with your bookmarks (*Bookmark in the Recording*) and writes them as CSV (*Export Recording as CSV*) or as a unit test (*Export Recording as Test…*: the pinned members of an FB's instance DB become a test of the FB, its inputs set as they changed on the machine, its outputs expected as they settled, from the start or a bookmark); a pinned integer shows in decimal, hex (16#…) or binary (2#…).
- **A git merge driver for PLC sources** (`rung merge-driver %O %A %B %P`): declarations both branches added to a VAR section, and test cases both added, stay without a conflict; anything else both changed is still one; rung sync merges a variable declared here and another declared in TIA Portal the same way. `rung init` writes the attributes; `git config merge.rung.driver "rung merge-driver %O %A %B %P"` turns it on in a clone (docs/ci.md).
- **The simulator checked against an S7-1500 runtime**: `tools/prove` runs test cases on rung's simulator and cycle by cycle on PLCSIM Advanced (the blocks as TIA Portal compiled them) and compares every output; 12 blocks (two of them LAD), 26 cases and 1501 values are the same (`docs/evidence.md`). It found and fixed: `NOT (x)` read as a call, `SHL(...)` calling a variable named `shl`, `16#00F3` refused in test files, FRAC missing, numbers converted to text without the CPU's sign and exponent form (`'+13824'`, `'+2.250000E+0'`), CHAR_TO_INT/INT_TO_CHAR, an integer divided by zero (0 as on the CPU, no longer an error), DELETE past the end, observed array-of-struct members in capitals, DATE and TIME_OF_DAY values in tests (they were text), a variable named like a word SCL reserves (`tod`, `time`, `Timer`… now an error in the editor, as TIA Portal refuses it), recorded values named `grid[0][1]` and `pt.X` (now `grid[0,1]`, `pt.x`), TONR missing, LTIME as a number in ms instead of ns; a REAL converted out of an integer's range now stops the case (a CPU leaves it undefined) instead of wrapping.
- **Tag tables as tables**: the declarations table shows a PLC tag table (`.tags.st`) like TIA Portal's: name, data type, address, a constant's value, HMI/OPC UA access, comment; addresses are edited in place and checked, a new tag gets the next free bit memory.
- **Monitor value column** in the declarations table of a DB or an FB (the eye button): the values the PLC or `rung simulate` has now next to the default values, like TIA Portal's DB editor, members of structures included, and the first 16 elements of an array; monitoring in the code shows them on their lines too.
- `rung xref` keeps TIA Portal's answer while nothing mirrored changed (no TIA Portal started to ask again; `--fresh` asks anyway); VS Code and the agents' `rung_xref` say when the kept answer was given.
- **Renames in TIA Portal** (V20, V21): a block, data type or DB renamed or moved to another group in TIA Portal keeps its file and history: pull, sync and watch know it by TIA Portal's own identity (ObjectIdentifierProvider), move the file (if it has no local edits), bring back the files that name it and rename it in the tests, instead of deleting one file and creating another.
- **Interface Impact** before a sync (`rung impact <file>`, VS Code *Interface Impact*, Neovim `:Rung impact`): what a change of an FB's, FC's or data type's interface breaks against the version TIA Portal has: calls that pass a parameter that went or leave out one an FC now wants, instance DBs reinitialised on download (multi-instances too), tests naming what went. Exit 2 when something breaks.
- **Why?** on a running PLC or `rung simulate` too (`rung why <file> <name>`, right-click in an SCL block, Neovim `:Rung why`): every statement of the block that writes the value, the IF/CASE branch each stands in with whether it holds now, and their operands, with the values read now. The answer copies as Markdown for a report or a ticket (VS Code: the copy button on the Why? view; Neovim: `Y`).
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
- TIA Portal V19 and V21 (pull, sync and compile tested on generated projects; blocks that would be SIMATIC SD stay SimaticML in V19). `rung init` picks the version from the project file; `rung setup openness` registers the bridge of every installed version.

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
