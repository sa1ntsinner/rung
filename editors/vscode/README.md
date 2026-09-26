# rung for VS Code

Siemens SCL support and TIA Portal two-way sync powered by [rung](https://github.com/sa1ntsinner/rung).

- Highlighting, completion (`#locals`, `"globals"`, members, standard functions), hover, go to definition, references, rename of locals, outline.
- Diagnostics from the SCL parser and from TIA Portal compiles (via `rung watch`).
- Commands: *rung: Pull*, *Sync*, *Start watch*, *Status*, *Resolve conflict*.

Requires the `rung` CLI (set `rung.command` if it is not on PATH). The extension is MIT licensed; the rung core it starts has its own license.
