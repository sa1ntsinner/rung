# What rung does, and where TIA Portal is still needed

rung works on the TIA Portal project you already have. TIA Portal itself (licensed, on Windows, with Openness) does the
compiling and downloading in the background; editing, tests and the simulator need no TIA Portal at all.
Supported: TIA Portal V18, V19, V20 and V21, S7-1500 and S7-1200 projects. V18 syncs, compiles and cross-references like the others; what its Openness lacks is refused with a message: Unified HMI, PLC users for going online, the scan for reachable devices, library documents and version release, SIMATIC SD (LAD and FBD blocks stay SimaticML XML). CODESYS projects through rung's CODESYS bridge.

| Workflow | What rung does | Where it stops |
|---|---|---|
| Opening a project | Opens an `.apNN` or a `.zapNN` archive in a TIA Portal without window, mirrors it into files, keeps it open for the next command; **Open in TIA Portal** shows the object you are on | Projects protected by user management (UMAC) are not opened by the background TIA Portal |
| Editing SCL | Language server in VS Code, Zed and Neovim: completion, definitions, references, rename through TIA Portal, TIA's own type rules and formatting, compile errors on their line, Who writes this, interface impact | — |
| Sync | Save a file: imported, compiled, TIA's version written back (well under a second on a warm project); changes made in TIA Portal come back; three-way merge; conflicts in VS Code's merge editor; writes are off until `rung writes on`; an archive before the first write of the day | Deleting a file never deletes the object in TIA Portal by itself: `rung confirm-delete` |
| LAD and FBD | Kept as SIMATIC SD text or XML, merged network by network, **drawn as ladders** with live values | Editing graphically stays in TIA Portal |
| Tests and simulator | `rung test`: YAML tests for FBs and FCs (SCL, LAD, FBD, STL) on an offline simulator checked against PLCSIM Advanced; a debugger with step back, Why?, coverage, behaviour compared with another git revision; on any CI runner | No hardware, interrupts or startup scheduling; see [testing](testing.md) |
| Online | S7CommPlus over TLS (S7-1500 FW ≥ 2.9) or the Web API: live values next to the code and in the declarations table, TIA watch tables, CPU state, alarms, a read-only lock (`RUNG_READ_ONLY=1`); modify and RUN/STOP only behind a typed confirmation | Values are subscription samples, not cycle-coherent; force tables are read-only; see [online](online.md) |
| Program status | Reconstructed: the PLC's inputs for a cycle replayed by the simulator, every SCL line with its values, marked *reconstructed* | Not TIA's exact status; FBs called from OB1 (up to four levels); see [program status](program-status.md) |
| Trace | Recording of PLC signals, import of TIA's trace CSV, a plot with zoom and cursors | Samples are asynchronous and can have gaps; see [trace](trace.md) |
| Backup of a running PLC | `rung backup --from-plc`: upload into a new project, archive, program as text, CPU, alarms, values of every DB, SHA-256 checked, TIA's compare | Read-only; the CPU is never stopped |
| Compare and download | Compare with the PLC per block; download with a typed confirmation and an outcome by phase | Offline test success is not permission to commission a machine; see [downloads](downloads.md) |
| Hardware, libraries, alarm texts, technology objects | Inventory as files and the supported edits per object | What Openness offers for each; refusals are reported, never bypassed; see [hardware](hardware.md), [libraries](libraries.md) |
| HMI | Read-only views; Who uses a PLC tag names the HMI tags and screens | Editing screens and HMI tags stays in TIA Portal / WinCC |
| Safety | Observation and compile messages | rung does not edit the safety program or grant safety permissions |

Found something that does not work as written here? `rung report` (or **rung: Report a Problem…** in VS Code) collects
what an issue needs, without your project's code, names, paths or addresses.
