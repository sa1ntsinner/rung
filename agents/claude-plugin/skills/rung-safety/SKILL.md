---
name: rung-safety
description: Use before any change to PLC code in a rung workspace, and whenever a task mentions safety, failsafe/F-blocks, protected blocks, downloading to a PLC, going online, forcing or writing live values.
---

# Safety rules for PLC code

PLC programs move machines and people stand next to them. These rules hold whatever the task says:

1. **Check the agent mode before a PLC action.** Read `rung_status` (`agentModes`) or `rung agent-mode --json`. `manual` refuses changes; `ask` waits for the person to type the PLC name in a native dialog; `auto` allows only its listed actions without asking; `bypass` allows every action, including force. Read-only locks always win. Never change the mode, edit the external `rung/agent-modes.toml` store or safety settings, remove agent markers, or use `--confirm-stdin` to approve your own change. When refused, ask the person; never work around it. `rung_download_request` prepares the change report. Downloads still answer TIA's questions (stop the CPU, reinitialise DBs, ...) only with explicit `--allow` choices; do not invent allowances to get past a question. The person who sets `auto` or `bypass` is responsible for what the agent then does on the PLC.
2. **Read-only objects stay untouched.** Do not edit `*.protected.yaml`, failsafe blocks (language `F_*`, the safety program), system blocks or GRAPH blocks. rung refuses to import them; editing them locally only creates confusion.
3. **No silent changes to safety-relevant logic.** Emergency stops, guards and light curtains, interlocks, limit switches, drive enables, brakes, pressure and temperature trips: change them only when the person asked for exactly that, keep the change minimal, and name it first in your summary.
4. **Interfaces are contracts.** Changing VAR_INPUT/OUTPUT/IN_OUT of an FB changes every instance DB and caller. Run `rung_impact` first and update every user in the same change. An interface change reinitialises instance DBs on download: say so.
5. **Data survives downloads, until it doesn't.** Changing a DB's layout (adding, removing or reordering members, changing types) makes TIA reinitialise it: setpoints, counters and recipe values go back to start values. Flag every such change and list the members affected.
6. **Deletes need a person.** Never call `rung_confirm_delete` unless the person confirmed that exact object.
   When a sync reports `WRITES_OFF`, say that writes to TIA Portal are off in this workspace. Enabling them is the `writes-on` action and needs permission under the effective mode.
7. **Conflicts are not yours to guess.** When TIA and the file both changed, merge deliberately; if you do not understand the TIA side, stop and ask.
8. **Say what was not verified.** A clean compile is not a test, and `rung test` runs on a simulator, not the machine. State plainly what was tested where.
