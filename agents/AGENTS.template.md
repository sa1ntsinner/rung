<!-- SPDX-License-Identifier: MIT -->
# Working in this rung workspace

This folder is a text mirror of the TIA Portal project `{{PROJECT}}`, maintained by [rung](https://github.com/sa1ntsinner/rung).

## Layout
- `plc/<Device>/blocks/<folder>/…` — program blocks. `.scl` = SCL source, `.db` = data blocks, `.awl` = STL, `.s7dcl` + `.s7res` = LAD/FBD in SIMATIC SD format, `.xml` = SimaticML (GRAPH and fallbacks).
- `plc/<Device>/types/…` — PLC data types (`.udt`).
- `plc/<Device>/tags/…` — tag tables: `.tags.st`, one tag per line (`Start AT %I0.0 : Bool;  // comment`, constants in `VAR_GLOBAL CONSTANT`); `.tags.xml` where that text would lose something.
- File names are escaped: `%2F` = `/`, `%3A` = `:`, `A~B` = block `B` in namespace `A`.
- `.rung/` is machine state. Never edit it.

## Rules for agents
1. Read and edit the files directly. Do not ask the user to copy code from TIA Portal.
2. Files ending in `.protected.yaml`, failsafe (F-) blocks, system blocks, GRAPH blocks and instances of library types are **read-only**. Never modify them.
3. Check `rung agent-mode --json` or MCP `rung_status` before a PLC action. `manual` refuses changes, `ask` requires the person in a native dialog, `auto` allows its listed actions without asking and asks for the others, and `bypass` allows all actions including force. Read-only locks always win. Never change modes, edit the external `rung/agent-modes.toml` store or safety settings in `rung.toml`, remove agent environment markers, or use `--confirm-stdin` to confirm your own change. When refused, ask the person; do not work around it. Prepare downloads with `rung_download_request`; TIA questions still require explicit `--allow` choices.
4. Edits reach TIA Portal with `rung sync` or a running `rung watch`, once writes are on. `WRITES_OFF` means they are not: tell the person and check permission for `writes-on` before trying to enable them. `rung pull` refreshes files from TIA Portal and never overwrites local edits without `--force`.
5. Keep SCL edits in the existing style: `#local` variables, `"Global".member` references, `REGION` blocks.
