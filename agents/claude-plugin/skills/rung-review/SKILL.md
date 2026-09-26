---
name: rung-review
description: Use when asked to review PLC changes in a rung workspace (a diff, a branch, uncommitted edits or "what changed in TIA") before they are synced or downloaded.
---

# Reviewing PLC changes

1. **Collect the change.** `rung_status` for files that differ from TIA; `rung_diff` per file (or `git diff` if the workspace is a git repo).
2. **Map the blast radius.** For every changed block, DB or UDT run `rung_graph` with `impact`, and `rung_find_usages` for changed DB members or tags. List callers and instance DBs affected.
3. **Check for PLC-specific risks** in each hunk:
   - scan-cycle behaviour: edge detection (`R_TRIG`/`F_TRIG`), timers (`TON` retriggering, PT units), latches that never reset;
   - initial values and retentivity (`NON_RETAIN`, start values in DBs) after a download;
   - integer overflow and division by zero, `REAL` equality comparisons;
   - array bounds and `FOR` loop limits against declared ranges;
   - outputs written in more than one place (use `rung_find_usages` for writes);
   - safety-relevant signals (e-stop, interlocks, enables) — flag any change.
4. **Compile evidence.** Run `rung_sync` (or `rung_compile`) and include `rung_diagnostics` results; never claim a change compiles without it.
5. **Report** per file: what changed, why it matters, risks found with line references, affected callers, and whether it needs machine testing. End with the reminder that the download is a human step in TIA Portal.
