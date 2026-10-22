# Changelog

## 0.3.4 (not published yet)

- Live access no longer refuses 192.168.1.1, the factory address of many CPUs' second interface. To keep a PLC out of reach, set `read_only = true` for it or `RUNG_READ_ONLY=1`.

## 0.3.3 — 2026-10-22

This release comes from working on open-source PLC projects with rung (traffic lights, an oven PID library, a MySQL client, OSCAT and a building services library for TwinCAT, a collection of SCL sources, a Factory IO line in LAD, STEP 7 Classic STL functions) and from two projects started from nothing through rung. What got in the way there is fixed here.

**Starting and checking a project**
- `rung init --new --project <dir>/<name>/<name>.ap20 --cpu <order number>` makes a new project with one CPU, the newest firmware TIA Portal has for it; writes are on, since nothing in it is anyone's yet.
- `rung lint` runs the language server's checks in a terminal or CI without TIA Portal: exit 1 on errors, `--max-warnings <n>`, a summary line, `--json`.
- `rung split` turns a source with several objects (TIA's *Generate source*, a library) into one file per object, named after it. The editor flags such a file, a file named after another object, and a block defined twice in one PLC.
- A call through an instance DB that does not exist yet (`"Belt_DB"(Start := …)`) is a warning naming the FB whose parameters fit, with a quick fix that writes the DB. An FB called without an instance, a timer called without IN or PT, and a TIME compared with a number are flagged as TIA Portal would.
- `rung new <fb|fc|ob|db|udt|tags> <name>` writes a new object in the layout TIA Portal exports, as the editor's wizard does; `rung new db Belt_DB --of Belt` writes an instance DB.
- `rung upgrade` and an export of an uncompiled block say to compile first. `.ap15_1` and `.zap15_1` are read as V15.1.

**Sync**
- Data types named without quotes (`buf : BufferUDT;`) order the sync like quoted ones, so a type reaches TIA Portal before the blocks that use it.
- After creating a block, sync says once that TIA Portal wrote it back in its own layout and that `rung format` lays out a new file that way.
- A file in another language than TIA Portal's object (Main.scl for a LAD Main) says how to switch: `rung confirm-delete` the old one, then sync creates it from the new file.

**Tests and simulator**
- STL: `SAVE` and the BR bit, an FC's ENO, local data bits (`L 0.0`), `TAK`, and references of STL operands for the editor and the stub check. A test can expect an FC's `ENO`, also from `ENO := FALSE;` in SCL.
- LAD counters on IEC_COUNTER data (`"Counter".CTU`), `#"quoted"` locals in SIMATIC SD, `#t.TON(...)` on a TON_TIME instance.
- `x AT y` views share one memory in the standard S7 layout; the SHA-256 of a MySQL client now gives the FIPS digests. Typed instructions of older SCL (`CEIL_DINT`, `ROR_DWORD`, `LIMIT_INT` …), `HTA`, `Strg_TO_Chars`, `Chars_TO_Strg` and `#str[i]` run.
- Program_Alarm needs no stub; a test can expect its signal. A stub's named parameters are the outputs of an STL `CALL` to a block nothing describes.
- IEC sources (TwinCAT, CODESYS): name lists, FB start values, `STRING(n)`, namespaces, PERSISTENT, type aliases, interfaces and EXTENDS parse; an interface variable binds to the FB assigned to it. The simulator runs FB inheritance: inherited variables and methods, `SUPER^()` and `SUPER^.Method()`.
- Test keys in TIA's quoted form (`Pid."idb_PI-Control".x`), a hint when a local is written with quotes, and an `always:` step that says when it failed before any cycle ran. Renaming a member renames nested test keys; editing a test keeps its YAML comments.
- `rung review` and `rung test --against` read the base revision with one git process, which matters on large workspaces.

**Online and agents**
- An agent may now do on a PLC what you can: download, live writes, RUN/STOP, `rung writes on`, on PLCSIM and on real PLCs alike. Restrictions are yours to choose: `rung agent-mode manual`, `ask` or `auto`, and `read_only` / `RUNG_READ_ONLY` as before. `rung setup` no longer writes deny rules into agent configurations; its hooks apply the mode you chose, and they let an agent edit `rung.toml` except the `read_only` and `allow_writes` lines.
- Downloads to PLCSIM work on a project that was not made for simulation: rung turns on "Support simulation during block compilation" and compiles; `rung init --new` turns it on from the start. A CPU that does not start after a software-only download points to `--hw`.
- `rung live modify` works on `rung simulate`, without a certificate or the per-PLC opt-in a real PLC needs.
- An agent's action is recorded when it starts and again when it ends; the Activity view shows one that did not finish. A refusal names the action and offers the download handover only for a download.

## 0.3.2 — 2026-10-21

- TIA Portal V18: init, pull, sync, compile, cross-reference and views through a V18 bridge, with `.ap18` and `.zap18` opened as they are instead of upgraded. What V18's Openness lacks (Unified HMI, PLC users, the scan for reachable devices, library documents, SIMATIC SD) is refused with a message that names V18.

- Agent permission modes per workspace and PLC: `manual`, native-dialog `ask`, selected-action `auto` and `bypass`, with expiry, action records and editor controls. Read-only locks always win; only the person changes the mode.

- Test cases count what they check. A case without `expect` passes by running and now says *checks nothing*; the totals, `--json`, the VS Code Testing view and `rung_test` show the counts. `rung test --strict` fails such cases, for CI.
- MCP tools check the files as they are on disk right after an edit, and `rung_test`, `rung_diagnostics` and `rung_impact` return a hash of the sources they used.
- The download handover compares the files with what TIA Portal has, not with the last git commit. It says plainly when rung cannot know something: what the PLC runs, or whether the project was compiled.
- In a VS Code window with several rung folders, the language server follows the folder chosen with *rung: Choose Workspace*.
- New Object makes program cycle OBs, and an FC can return any elementary type or a PLC data type.
- Zed tasks save edited buffers before they read the files.
- Neovim: a test result arriving after a newer run, or after its buffer closed, is dropped, and live pins belong to their workspace. CI now runs the Neovim checks, including the debugger and neotest, against a pinned Neovim.
- VS Code says what a PLC action does: *Put PLC_1 in STOP?* with a *STOP PLC_1* button instead of *Confirm*, *Modify value…* as a labelled button next to Monitor, a refused write ends with *Nothing was sent to the PLC*, and a declarations table that lost its PLC says the values are not current. Pressed toggles show in high-contrast themes, the trace view takes the editor's theme and reads as a recording, narrow panels keep the block name and the ladder toolbar in view, and New Object names each step.
- Zed has a task to turn writes to TIA Portal off again.
- Pricing and licence pages say what the free `rung review` covers, what Pro adds, and who needs Pro, with examples.

## 0.3.1 — 2026-10-21

- Agents cannot download, write PLC values, force, acknowledge alarms, switch RUN/STOP or enable writes through the CLI. `rung setup` installs shell deny rules alongside the existing skills and MCP registration. A refusal asks the person to run the command in their own terminal.
- MCP tools describe whether they read or change the project, return structured results, and require a person for deletes and conflict resolution. `rung_sync_preview` previews a sync separately from sending it. Large lists, test results, previews and graph responses have limits and paging.
- The Claude plugin runs the SCL language server after edits, blocks unsafe shell commands, and adds read-only reviewers and online diagnosticians. Its launcher uses the bundled CLI, and release packaging keeps its version with rung.
- `rung review` reports changes against HEAD or a git range per block, including interfaces, SCL regions or LAD networks and affected callers, data blocks and tags. It produces Markdown or JSON and is available as a read-only MCP tool.
- Download and live-change commands that a person confirms in VS Code still run when VS Code itself was started by an agent.
- New rung mark on the extension icon and in the activity bar.

## 0.3.0 — 2026-10-21

**Online with the PLC**
- S7CommPlus over TLS (S7-1500 firmware 2.9 and later), without the PLC's web server: live values next to the code, in the declarations table and the ladder view, TIA watch tables live, CPU state and cycle time, alarms and the diagnostic buffer; subscriptions shared by every editor and agent of the workspace through one broker. The PLC's certificate is pinned by its SHA-256 (`rung live trust`). Modify, RUN and STOP only behind a typed confirmation and a per-PLC opt-in; force tables stay read-only. Checked on PLCSIM Advanced and, read-only, on a CPU 1516 of a machine.
- **Program status, reconstructed**: the inputs of one cycle of an FB called from OB1 (up to four levels down, multi-instances, structures, arrays, timers and counters as the PLC has them) replayed by the simulator; every SCL line shows the values it computed, marked *reconstructed*, with any difference to what the PLC wrote. Not TIA Portal's exact status, and labelled so.
- **Trace**: `rung trace record` samples PLC signals over S7CommPlus, `rung trace import` reads TIA Portal's long-term trace CSV, and VS Code plots both (zoom, cursors, scales, gaps shown as gaps).

**LAD and FBD**
- LAD blocks drawn as ladders (`rung: Show as Ladder`), in the editor's theme, with live values: power from the rail in green, coils and boxes in their operands' state, compare values beside their operands.

**Project assets**
- Hardware settings beyond IP addresses (any writable setting, catalogue modules), library types and master copies (release, update, import), alarm text lists, technology object parameters, HMI Basic/Comfort panels in `rung views`, safety observed read-only; each through a preview and an apply against the revision it was previewed on. `rung retrieve` and `rung upgrade` open `.zapNN` archives and older projects.

**Smaller things**
- `rung report` and *rung: Report a Problem…* in VS Code: versions, this PC's checks and the workspace's shape for a bug report, without the project's code, names, paths or addresses (shown in an editor before it is copied).
- `rung confirm-delete` takes several files: the blocks only another git branch had, after switching back.
- The Environment view marks what TIA Portal sync cannot do without (the Openness group, the whitelist) in red as *needed*, apart from optional tools that are *not installed*.
- A clean compile of hundreds of blocks names the first eight and a count instead of all of them on one line.
- The command palette no longer lists commands that belong to one view's toolbar.
- Measured on a 624-object project: a saved FB is compiled in TIA Portal about a second later; switching git branches with 57 changed files is synced in about 40 s; creating 600 blocks takes 7 minutes.

- A read-only lock (`RUNG_READ_ONLY=1` or per-PLC `read_only = true`) blocks PLC changes and TIA imports across the CLI, hosts and VS Code. Watch exports only, and protected-address reads require the lock. `rung init --from-plc` still works under it, into a new project only.
- `rung backup --from-plc <ip> --out <folder>`: everything rung can read from a running S7-1500 in one folder, the PLC only read: station upload into a new project and its archive, the online compare proving the copy complete, the program as text, CPU identity, state and certificate, alarms, every data block's values, a manifest and SHA-256 sums; `rung backup verify` and `rung backup diff` for later. Measured on a CPU 1516 over a VPN: 4 minutes, 185 objects, 2395 values, cycle time unchanged.
- Found on a real S7-1500: the upload answers the certificate question of a PLC with secure communication (`--trust-certificate`, else a clear refusal) and reports a failed upload as failed even when a station came; `rung live watch --file` of an instance or UDT-typed DB shows its values (it showed none); a user constant of a tag table is no longer read from the PLC; the live broker replaces a host that exited and subscribes again, and a watch without live values for 60 s stops (`--reconnect-timeout`); `rung trace record` does not count connecting as recording time (`connectMs`); `rung live trust --expect-sha256` pins without a terminal; `rung retrieve` and `rung upgrade` refuse at once a `RUNG_BRIDGE` that TIA Portal's Openness whitelist does not know, instead of waiting 15 minutes on a question no window shows; a failed go-online names the interface it used.

**TIA Portal without window**
- *Open TIA Project…* in VS Code checks the local PC or another Windows PC over ssh, mirrors the project and starts watch. Watch starts with a trusted folder by default (`rung.watch.autoStart`). A keeper reuses one background TIA Portal for the project's commands and editors (10 min idle, `RUNG_KEEPER_IDLE_S`); *Open in TIA Portal* moves the project into a window, with *Save and Open* for unsaved changes. `rung session` inspects it without starting TIA Portal; `rung session --release` stops watch and releases the background project. The PLC picker remembers its last choice. `rung connect --address` edits `network.yaml` for V19/V20; V21 uses an online address with the project unchanged. PLC passwords and users come from the CLI environment or VS Code's secret storage. Untrusted TLS certificates require consent for that connection, never remembered. V21 Openness setup writes its `AllowList`. See [Going online](docs/online.md) and the [measurements](docs/evidence.md#tia-portal-without-window-measured).

**Debugging and testing**
- Tests on an exported project with gaps: a data block the workspace does not have (a library PID's instance DB left out of the export) can be stubbed by its quoted name, and 64-bit integers past 2^53 are set exactly as `16#…` (a CANopen word in an LWord's top word); a plain number past 2^53, or a `16#…` a double cannot hold, is refused. On Linux, the Neovim check skips a Neovim older than 0.11 instead of hanging on `nvim -l`.
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
