---
name: plc-data-design
description: Use when adding or changing data blocks, UDTs (PLC data types), FB instances, tag tables or HMI/recipe data in a TIA Portal project, or when a change could reinitialise PLC data on download.
---

# Designing PLC data

## Where data lives

- **Instance data** of an FB: its `VAR` section. Give every piece of equipment its own FB instance; prefer **multi-instances** (an FB declared in the `VAR` of its parent FB) over one instance DB per object, so the structure of the program is the structure of the data.
- **Global DBs** for data several parts of the program share: HMI interface, recipes, alarms, communication buffers. One DB per purpose, not one DB for everything.
- **UDTs** for every structure used more than once (an HMI faceplate interface, a recipe record, a telegram). Change the UDT, not copies of it.
- **Tags** (`%I`, `%Q`, `%M`) only for the physical I/O image and what hardware configuration forces; name them after the device (`B12_DoorClosed`, `Y3_ValveOpen`) and map them into the program in one place.

## Changes that reset data on download

TIA reinitialises a DB or instance DB when its structure changes: added, removed, renamed or reordered members, type changes, changes in a UDT used inside it, interface changes of the FB that owns an instance. After such a download setpoints, counters, recipe values and learned positions go back to their start values unless they are retentive and the change allows TIA to keep them.

So:
- Add new members at the **end** of a DB or UDT; do not reorder for tidiness.
- Never change the type of an existing member to reuse it; add a new one.
- Put values the operator sets (setpoints, recipes, calibration) in their own DB that rarely changes structurally.
- Mark data that must survive a power cycle `RETAIN` (and know the CPU's retentive memory limit).
- List every DB and instance whose structure your change touches in the summary, with the values that will be lost. `rung download` shows TIA's "reinitialise" question; the person decides.

## Passing data

- Large structures and arrays go through `VAR_IN_OUT` (by reference); `VAR_INPUT` copies them every call.
- Do not access global DBs from inside a reusable FB; pass what it needs through its interface, so the same FB works for the next machine.
- `Variant` and `DB_ANY` are for generic library blocks, not for everyday logic.

## Start values and simulation

`rung test` and `rung simulate` apply DB start values from the `BEGIN` section and declared initial values. When a behaviour depends on values the operator sets, set them in the test's `set` step instead of relying on start values.
