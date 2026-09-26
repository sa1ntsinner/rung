---
name: iec-st-portable
description: Use when working on IEC 61131-3 Structured Text for Beckhoff TwinCAT 3 or CODESYS (.st, .TcPOU, .TcDUT, .TcGVL files), or when moving logic between Siemens SCL and IEC ST.
---

# IEC 61131-3 ST on TwinCAT and CODESYS

rung reads TwinCAT and plain ST files directly (no bridge): the language server, `rung test` and the simulator understand PROGRAM, FUNCTION_BLOCK, METHOD, GVLs and DUTs. TwinCAT XAE / CODESYS still build, download and go online. Check with `rung_check` whether they are installed; if not, say so and quote the install link it gives (both are free with a vendor account), then continue with what rung can do without them.

## Differences from Siemens SCL that bite

| | Siemens SCL | IEC ST (TwinCAT/CODESYS) |
|---|---|---|
| local variable | `#speed` | `speed` |
| global | `"DB".member` | `GVL_Plant.member` (with `qualified_only`) or `member` |
| block names | quoted `"FB_Pump"` | bare `FB_Pump` |
| cyclic program | OB1 calls FBs | `PROGRAM MAIN` in a task |
| timers | `TON_TIME` / `TON` multi-instance | `TON` instance, `PT := T#2S` |
| methods, interfaces | no | `METHOD`, `INTERFACE`, `THIS^`, `SUPER^` |
| pointers | `REF_TO` (limited) | `POINTER TO`, `REFERENCE TO`, `ADR()` |
| I/O mapping | tag table `%I0.0` | `AT %I*` linked in the I/O tree |

## Habits

- Keep TwinCAT XML files (`.TcPOU` etc.) intact: edit only the code inside `<Declaration>` and `<ST>`; never touch GUIDs or the XML around them.
- Qualified GVL access (`{attribute 'qualified_only'}`) keeps globals findable.
- Methods of an FB see its variables; do not duplicate state into method locals.
- Everything in `plc-engineer`, `scl-craft` (minus the Siemens syntax) and `plc-testing` applies the same way; `rung test` runs ST FBs, FCs and PROGRAMs, but not `THIS^`, pointers or methods yet.
