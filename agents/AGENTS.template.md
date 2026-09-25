<!-- SPDX-License-Identifier: MIT -->
# Working in this rung workspace

This folder is a text mirror of the TIA Portal project `{{PROJECT}}`, maintained by [rung](https://github.com/sa1ntsinner/rung).

## Layout
- `plc/<Device>/blocks/<folder>/…` — program blocks. `.scl` = SCL source, `.db` = data blocks, `.awl` = STL, `.s7dcl` + `.s7res` = LAD/FBD in SIMATIC SD format, `.xml` = SimaticML (GRAPH and fallbacks).
- `plc/<Device>/types/…` — PLC data types (`.udt`).
- `plc/<Device>/tags/…` — tag tables (`.tags.xml`).
- File names are escaped: `%2F` = `/`, `%3A` = `:`, `A~B` = block `B` in namespace `A`.
- `.rung/` is machine state. Never edit it.

## Rules for agents
1. Read and edit the files directly. Do not ask the user to copy code from TIA Portal.
2. Files ending in `.protected.yaml`, failsafe (F-) blocks, system blocks and GRAPH blocks are **read-only**. Never modify them.
3. Never download anything to a real PLC. Downloads are done by a human in TIA Portal.
4. `rung pull` refreshes files from TIA Portal and never overwrites local edits without `--force`.
5. Keep SCL edits in the existing style: `#local` variables, `"Global".member` references, `REGION` blocks.
