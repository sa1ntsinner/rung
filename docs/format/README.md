<!-- SPDX-License-Identifier: MIT -->
# rung workspace format 1

Normative description of the on-disk layout shared by every rung component and third-party tool. Licensed MIT so other tools may implement it.

- `rung.toml` — project binding (`project.path`, `project.tiaVersion`), device aliases, sync options, `format = 1`.
- `.rung/` — machine state (never committed): `state.json`, `base/` (content-addressed bundles), `journal/`, `trash/`, `recovery/`, `tmp/`, `lock`, and `revisions.json` (the fingerprint TIA Portal gave each object for its modification dates, so a new bridge reads again only what changed; deleting it is safe, the next sync reads every fingerprint once).
- `plc/<Device>[/units/<Unit>]/<kind>/<group>/…/<leaf>.<form>` where kind ∈ `blocks, types, tags, techobjects, watch, force, hardware` and form ∈ `scl, awl, db, udt, s7dcl, xml, tags.xml, tags.st, protected.yaml, st, yaml` (longest suffix first: `tags.st` before `st`). A `.tags.st` file is a TIA tag table as an IEC global variable list, one tag per line (`Name [{External… := 'false'}] AT %address : Type;  // comment`, user constants in `VAR_GLOBAL CONSTANT`); `.st` in `tags/` is a CODESYS global variable list. `plc/<Device>/hardware/network.yaml` holds the network settings of the PLC (one per PLC, never created or deleted from the workspace). SD objects also have companion `.s7res` files with the same leaf. A software unit's blocks, PLC data types and tag tables are under `units/<Unit>/` and are created, edited and deleted there like the PLC's own; the units themselves, their relations and safety units are made in TIA Portal, and watch and force tables belong to the PLC.
- Leaf = `escape(name)` or `escape(namespace)~escape(name)`.
- `escape`: percent-encode (upper-case hex, UTF-8 code units ≤ 0x7F only) the characters `/ \ : * ? " < > | % ~`, control characters and DEL; encode every trailing `.` or space; encode the first character of a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without extension). Decoding must be canonical: `escape(unescape(s)) === s`.
- Address = `plc:` + the same segments without the `plc/` prefix and without the form extension, e.g. `plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor`.
- Test vectors: `docs/format/address-vectors.json` (used by the TypeScript and C# test suites).
