---
name: scl-craft
description: Use when writing or reviewing SCL (Structured Control Language) for Siemens S7-1200/1500 in TIA Portal: block structure, naming, formatting, idioms and pitfalls that make SCL readable and correct.
---

# Writing good SCL for S7-1200/1500

Match the file you are in first; these rules are for new code and for code that already follows no convention.

## Structure

- One job per block. An FB owns a piece of equipment or a function (valve, axis, recipe handling); an FC computes without memory. OBs only call blocks.
- Order in an FB: `VAR_INPUT` (commands and feedbacks), `VAR_OUTPUT` (status, commands out), `VAR_IN_OUT` (large structures passed by reference), `VAR` (static state and multi-instances), `VAR_TEMP`, `VAR CONSTANT`.
- Group the body with `REGION` / `END_REGION`: inputs and edge detection, state machine, outputs, alarms. Outputs are assigned in one region at the end of the block.
- Keep `{ S7_Optimized_Access := 'TRUE' }` (the default). Only standard-access DBs need absolute addressing; avoid `%M`, `%DB1.DBX0.0` style in new code.

## Names

- Variables `camelCase` (`startCmd`, `fillLevelPct`), constants `UPPER_SNAKE` in `VAR CONSTANT`, blocks and UDTs as the project does (commonly `FB_Conveyor`, `FC_Scale`, `UDT_Motor`, `DB_Line1`). Booleans read as a statement: `isRunning`, `hasFault`, `doorClosed`.
- Local access with `#name`, globals with `"DB".member`; never shadow a global with a local of the same name.
- Magic numbers become named constants: `IF #tempDegC > #MAX_TEMP_DEGC THEN`.

## Idioms

- **Edges:** an `R_TRIG` instance per signal in `VAR`: `#startEdge(CLK := #start); IF #startEdge.Q THEN ...`.
- **Timers:** IEC timer instances (`TON_TIME`/`TON` as multi-instance in `VAR`), called every scan, unconditionally: `#tDelay(IN := #waiting, PT := T#2s);` then use `#tDelay.Q`. A timer called inside an `IF` stops being evaluated when the condition drops.
- **State machines:** `CASE #state OF` with named constants for the states, one place that changes `#state`, a timeout timer per waiting state, and `ELSE` going to a fault state.
- **Limits:** `LIMIT(MN := 0.0, IN := #setpoint, MX := #MAX)`; integer math that can overflow is done in `DINT`/`LREAL`; guard every division.
- **Comparisons:** never `=` on `REAL`; compare with a tolerance (`ABS(#a - #b) < 0.001`).
- **Loops:** `FOR` bounds from the array declaration (`LOWER_BOUND`/`UPPER_BOUND`, or constants), no `WHILE` waiting for a signal: the scan must finish.
- **Type conversion:** explicit (`INT_TO_REAL`, `DINT_TO_INT` after checking the range). Implicit conversions hide truncation.

## Pitfalls TIA will not warn about

- Outputs keep their last value when the code that writes them is skipped (inside an `IF`, after an early `RETURN`). Write every output every scan.
- Assign every FC output before any `RETURN`: an output the FC never writes gives the caller an undefined or stale value.
- `VAR_TEMP` holds nothing between calls. Assign it before you read it, every call.
- Non-retentive data goes back to its start values at every CPU start (power on, STOP → RUN); only `RETAIN` data keeps its value. A download that reinitialises a DB resets both.
- A string parameter passed `VAR_INPUT` is copied every call; pass large structures and arrays as `VAR_IN_OUT`.

## Formatting

rung writes back TIA's canonical formatting after every import: upper-case keywords, TIA's indentation, literals like `T#5S` and `16#000C`. Do not fight it; write clean code and re-read the file after a sync.
