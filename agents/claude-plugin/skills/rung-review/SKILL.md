---
name: rung-review
description: Use when asked to review PLC changes in a rung workspace (a diff, a branch, uncommitted edits or "what changed in TIA") before they are synced or downloaded.
---

# Reviewing PLC changes

1. **Collect the change.** `rung_review` reports the working tree against HEAD or a requested git range, per block, in Markdown or JSON. `rung_status` identifies files that differ from TIA; `rung_diff` compares each file with its last synced version.
2. **Map the blast radius.** For every changed block, DB or UDT run `rung_impact`, and `rung_find_usages` for changed DB members or tags. List callers and instance DBs affected.
3. **Check for PLC-specific risks** in each hunk:
   - scan-cycle behaviour: edge detection (`R_TRIG`/`F_TRIG`), timers (`TON` retriggering, PT units), latches that never reset;
   - initial values and retentivity (`NON_RETAIN`, start values in DBs) after a download;
   - integer overflow and division by zero, `REAL` equality comparisons;
   - array bounds and `FOR` loop limits against declared ranges;
   - outputs written in more than one place (use `rung_find_usages` for writes);
   - safety-relevant signals (e-stop, interlocks, enables) — flag any change.
4. **Compile evidence.** Read `rung_diagnostics` and state the available TIA compile evidence. A read-only review never syncs or compiles. If the person requests a project sync, preview with `rung_sync_preview` before `rung_sync`; never claim a change compiles without the result.
5. **Report** per file: what changed, why it matters, risks found with line references, affected callers, and whether it needs machine testing. End with the reminder that the download is a human step in TIA Portal.
