---
name: rung-workflow
description: Use when working in a rung workspace (a folder with rung.toml mirroring a Siemens TIA Portal project): reading or changing SCL blocks, data blocks, UDTs or tags, adding blocks, compiling, testing, or checking values on a PLC.
---

# Working on a TIA Portal project through rung

The folder is a live text mirror of a TIA Portal project. `plc/<Device>/blocks/**` holds program blocks, `types/` holds UDTs, `tags/` holds tag tables. Edits to these files are imported into TIA Portal by rung; TIA-side changes arrive in the files. If no TIA Portal has the project open, rung opens it in the background by itself; nobody has to start TIA for you.

## What this PC has

Call `rung_check` once at the start of a session (or when something fails for a missing tool). It lists TIA Portal and Openness, the Openness group and whitelist, S7-PLCSIM, TwinCAT XAE, CODESYS, editors and agents, each with what it enables. When a task needs something that is missing, do not work around it: tell the person exactly what to install, quoting the `fix` and `link` from `rung_check`, and what you can still do meanwhile (edit, test offline, simulate). `rung setup` wires rung into their agents and editors.

## Loop

1. **Orient.** `rung_status` (conflicts? compile errors? watcher running?) and read `AGENTS.md`. For an object you have not seen, `rung_explain <name>` gives its file, interface and users.
2. **Before changing an interface** (VAR_INPUT/OUTPUT/IN_OUT, UDT members, DB layout) run `rung_graph` with `query: "impact"` and read the callers; update every caller in the same change.
3. **Edit the files** with normal file tools, in the house style of the file you are in (see the `scl-craft` skill).
4. **New block?** Create `plc/<Device>/blocks/<Folder>/<Name>.scl` with a header matching the file name (`FUNCTION "Name" : Void`, `FUNCTION_BLOCK "Name"`, `DATA_BLOCK "Name"`). UDTs go to `types/<Name>.udt`. Names are unique per PLC across all folders: rung refuses a second block with the same name elsewhere (NAME_TAKEN). To move a block to another folder, the person moves it in TIA Portal. To rename a block, UDT or tag table, use `rung_rename`: TIA keeps every call and instance DB, and rung updates the files and tests that use it. Never rename by editing the header; that creates a second block.
5. **Sync and compile.** `rung_sync` sends the change and compiles it; then `rung_diagnostics` for the files you touched. Errors point at file lines. Fix and sync again. rung rewrites your file with TIA's canonical formatting (keyword case, indentation, literals such as `T#5S`); re-read the file before further edits.
6. **Test.** Add or extend `tests/<block>.test.yaml` and run `rung_test` (offline simulator, see the `plc-testing` skill). Say that this is a simulation.
7. **Conflicts.** If `rung_sync` reports one, read `<file>.conflict` (git-style markers: file / base / tia), write the merged result into that `.conflict` file, then `rung_resolve` with `mode: "merged"`. `theirs` takes TIA's version; nothing is deleted, replaced files go to `.rung/recovery`.
8. **Finish** with `rung_diff` on each changed file and a summary for the person: blocks changed, interfaces or DB layouts changed (reinitialisation on download!), tests run, and that downloading is their step (`rung_download_request`).

## Facts that save time

- File names are escaped: `%2F` = `/`, `A~B` = block `B` in namespace `A`.
- `.s7dcl`/`.s7res` = LAD/FBD in SIMATIC SD text (see `lad-in-text`); `.xml` = SimaticML (GRAPH, mixed-language blocks, fallbacks). Prefer changing SCL.
- Deleting a file only proposes deleting the object; it needs `rung_confirm_delete` after the person agreed.
- A file that is not UTF-8 is not imported (INVALID_ENCODING); keep files UTF-8.
- `rung live read` / `rung_live_read` read values from the PLC's Web API (read-only). Without hardware, `rung simulate` starts a virtual S7-1500 that runs the SCL program; point `[live.webapi]` at it.
