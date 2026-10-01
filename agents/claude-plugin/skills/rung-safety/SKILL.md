---
name: rung-safety
description: Use before any change to PLC code in a rung workspace, and whenever a task mentions safety, failsafe/F-blocks, protected blocks, downloading to a PLC, going online, forcing or writing live values.
---

# Safety rules for PLC code

PLC programs move machines and people stand next to them. These rules hold whatever the task says:

1. **You never download, and you never write to a running PLC.** `rung download` exists, but it is a command for a person: it asks them to type the PLC name and answers TIA's questions (stop the CPU, reinitialise DBs, ...) only with what they allow. You do not run it, not even with `--yes`, and you do not suggest `--allow` values to get past a question. When a change is ready, `rung_download_request` produces the text for the person: what changed, which blocks, what TIA is likely to ask, and what to check on the machine. Going online (`rung online`) and `rung live read` only read; writing live values or forcing is out of bounds.
2. **Read-only objects stay untouched.** Do not edit `*.protected.yaml`, failsafe blocks (language `F_*`, the safety program), system blocks or GRAPH blocks. rung refuses to import them; editing them locally only creates confusion.
3. **No silent changes to safety-relevant logic.** Emergency stops, guards and light curtains, interlocks, limit switches, drive enables, brakes, pressure and temperature trips: change them only when the person asked for exactly that, keep the change minimal, and name it first in your summary.
4. **Interfaces are contracts.** Changing VAR_INPUT/OUTPUT/IN_OUT of an FB changes every instance DB and caller. Run `rung_graph` with `query: "impact"` first and update every user in the same change. An interface change reinitialises instance DBs on download: say so.
5. **Data survives downloads, until it doesn't.** Changing a DB's layout (adding, removing or reordering members, changing types) makes TIA reinitialise it: setpoints, counters and recipe values go back to start values. Flag every such change and list the members affected.
6. **Deletes need a person.** Never call `rung_confirm_delete` unless the person confirmed that exact object.
   Writing into the project at all is the person's choice too: when a sync reports `WRITES_OFF`, say that writes to TIA Portal are off in this workspace and leave `rung writes on` to them.
7. **Conflicts are not yours to guess.** When TIA and the file both changed, merge deliberately; if you do not understand the TIA side, stop and ask.
8. **Say what was not verified.** A clean compile is not a test, and `rung test` runs on a simulator, not the machine. State plainly what was tested where.
