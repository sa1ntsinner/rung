---
name: rung-workflow
description: Use when working in a rung workspace (a folder with rung.toml mirroring a Siemens TIA Portal project) — reading or changing SCL blocks, data blocks, UDTs or tags, adding blocks, or checking that a change compiles in TIA Portal.
---

# Working on a TIA Portal project through rung

The folder is a live text mirror of a TIA Portal project. `plc/<Device>/blocks/**` holds program blocks, `types/` holds UDTs, `tags/` holds tag tables. Edits you make to these files are imported into TIA Portal by rung; TIA-side changes arrive in the files.

## Loop

1. **Orient.** `rung_status` (conflicts? watcher running?) and read `AGENTS.md`. For an object you have not seen, `rung_explain <name>` gives its file, interface and users.
2. **Before changing an interface** (VAR_INPUT/OUTPUT/IN_OUT, UDT members, DB layout) run `rung_graph` with `query: "impact"` and read the callers; update every caller in the same change.
3. **Edit the files** with normal file tools. Keep the house style: `#local` variables, `"Global".member`, `REGION` blocks, one statement per line, 3-space indentation as in the existing file.
4. **New block?** Create a new file in the right folder: `plc/<Device>/blocks/<Folder>/<Name>.scl` with a header matching the file name (`FUNCTION "Name" : Void`, `FUNCTION_BLOCK "Name"`). UDTs go to `types/<Name>.udt` and are imported before blocks that use them.
5. **Sync and compile.** `rung_sync` sends the change and compiles it; then `rung_diagnostics` for the files you touched. Fix compile errors in the files and sync again. rung rewrites your file with TIA's canonical formatting — that is expected; re-read the file before further edits.
6. **Conflicts.** If `rung_sync` reports a conflict, read `<file>.conflict` (git-style markers: file / base / tia), write the merged result into the file, then `rung_resolve` with `mode: "merged"`. Use `theirs` to discard your edit.
7. **Finish** with `rung_diff` on each changed file and a short summary for the human, including which PLC blocks changed and that a download from TIA Portal is still required.

## Facts that save time

- File names are escaped: `%2F` = `/`, `A~B` = block `B` in namespace `A`.
- `.s7dcl`/`.s7res` = LAD/FBD in SIMATIC SD text; `.xml` = SimaticML (GRAPH and fallbacks). Prefer changing SCL; graphical blocks conflict easily.
- Deleting a file only *proposes* deleting the object; it needs `rung_confirm_delete` (ask the human first).
- `rung_sync` without a running `rung watch` briefly starts its own bridge; if TIA Portal is not running you get `TIA_NOT_RUNNING` — ask the human to open the project.
