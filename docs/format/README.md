<!-- SPDX-License-Identifier: MIT -->
# rung workspace format 1

Normative description of the on-disk layout shared by every rung component and third-party tool. Licensed MIT so other tools may implement it.

- `rung.toml` — project binding (`project.path`, `project.tiaVersion`), device aliases, sync options, `format = 1`.
- `.rung/` — machine state (never committed): `state.json`, `base/` (content-addressed bundles), `journal/`, `trash/`, `recovery/`, `tmp/`, `lock`.
- `plc/<Device>[/units/<Unit>]/<kind>/<group>/…/<leaf>.<form>` where kind ∈ `blocks, types, tags, techobjects, watch, force` and form ∈ `scl, awl, db, udt, s7dcl, xml, tags.xml, protected.yaml`. SD objects also have companion `.s7res` files with the same leaf.
- Leaf = `escape(name)` or `escape(namespace)~escape(name)`.
- `escape`: percent-encode (upper-case hex, UTF-8 code units ≤ 0x7F only) the characters `/ \ : * ? " < > | % ~`, control characters and DEL; encode every trailing `.` or space; encode the first character of a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without extension). Decoding must be canonical: `escape(unescape(s)) === s`.
- Address = `plc:` + the same segments without the `plc/` prefix and without the form extension, e.g. `plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor`.
- Test vectors: `docs/format/address-vectors.json` (used by the TypeScript and C# test suites).
