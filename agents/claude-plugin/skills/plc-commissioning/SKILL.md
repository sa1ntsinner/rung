---
name: plc-commissioning
description: Use when a PLC change is ready to go to a machine, when diagnosing a running machine (faults, "it stopped", unexpected behaviour) with live values, or when the person asks about going online, downloading, the diagnostic buffer or a test plan for the machine.
---

# From a finished change to a running machine

You prepare; a person downloads and tests on the machine. Your job is to make their part short and safe.

## Before the person downloads

1. `rung_status`: no conflicts, no pending deletes, no compile errors (`rung_diagnostics`).
2. List what the download changes: blocks, DBs and instances whose structure changed (they get reinitialised, see `plc-data-design`), hardware configuration if touched.
3. Predict TIA's questions and say what they mean: a changed interface or DB layout usually needs the CPU in STOP ("stop-cpu") and may reinitialise data ("reinit-db"). `rung download` cancels unless the person allows each one; tell them which to expect and why, never how to get around them.
4. Write the machine test: preconditions (machine in manual, area clear, e-stop tested), the steps, the expected reaction, what to watch (`"DB".member` names for `rung live read`), and how to roll back (the previous version is in git; download it the same way).
5. `rung_download_request` produces this summary for the person.

## Diagnosing a running machine (read-only)

- `rung online --state` and `rung live read '"DB".member' ...` read values from the PLC's Web API; `rung live diag` reads the diagnostic buffer. Start from the symptom: which output is (not) set, then walk back through the logic to the input or state that decides it.
- Compare what the code expects with what the values say, one condition at a time; quote the values you read in your explanation.
- Never write values, force, or change operating mode. If the fix needs a change, make it in the files and go back to the steps above.

## Without hardware

`rung simulate` gives a virtual S7-1500 (Web API only) that runs the SCL program; S7-PLCSIM (`rung_check` says whether it is installed; otherwise quote its install hint) is what TIA Portal can go online and download to. Say which one a result came from.
