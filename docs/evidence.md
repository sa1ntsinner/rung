# Evidence

What has been measured, on which commit, and what it does and does not show.

## TIA Portal without window, measured

Measured on 2026-10-06/07 on a laptop with a copy of RungProve. The first lifecycle spike used Openness V20 directly; the later runs used rung's keeper and window handoff (`8d267b3`, `ba7af41`, `9d69914`, `c67f963`).

| Operation | Measured time |
|---|---|
| Cold start without window and project open | about 10–20 s: 10–11 s in the direct spike with warm disk, 16–19 s for rung's cold pull |
| Attach to a running TIA Portal without window | about 70 ms (70–90 ms in the spike) |
| Warm `rung pull` | about 1 s |
| Open in TIA Portal | about 28 s after the keeper fixes; 31 s in the earlier run |
| Background TIA Portal reopened after closing the window | 15–17 s after the fixes |

Two concurrent cold starts used one keeper. The idle keeper exited cleanly. The direct spike could attach several clients at once. One measuring loop saw 83–86 s for the return to the background in its first round; the trace script did not reproduce it. These times describe this project and PC, not every project or disk.

V20 could not go online at an address outside the project: applying a created address was refused. With PLCSIM Advanced, changing the project's address through `network.yaml` and sync allowed it to go online. V19 uses the same project-address path in rung; the measurement was on V20.

V21 could go online at another address (`8318938`): a real V21 with PLCSIM reached `192.168.250.1` while the project gave `192.168.254.1`. The project stayed unchanged.

The V21 TLS spike refused both the default `NonVerified` and explicit `NonTrusted` selections; `Trusted` connected. rung refuses an untrusted certificate unless consent is given for that connection (`a0a9195`, `a6cc192`). rung's PLCSIM path uses legacy communication and asks for no certificate, so these runs do not verify rung's TLS path on a real PLC. PLC password callbacks did not fire on the protected PLCSIM Advanced instance; password and user management still need a protected real S7-1500 check.

## Online through S7CommPlus, measured

Measured on 2026-10-10 against a PLCSIM Advanced 7.0 CPU 1516 (firmware 2.9) on this PC, over TLS 1.3 with the
certificate pinned by its SHA-256:

- 11 values read by name (BOOL, INT, REAL, STRING in a global DB, array elements of one and two dimensions, a
  member of an array of structures, a multi-instance member, I and Q tags) equal the values the PLCSIM API reports.
- The first value of a newly opened monitor arrives in 80–110 ms once the connection is up.
- Modifying a BOOL, an INT, a REAL and a STRING each needs a confirmation that shows the PLC, its serial number, the
  old value and the new one; the PLC reports the new value and the old one is restored afterwards.
- STOP and RUN are confirmed the same way; the CPU's own alarms about the mode change arrive while it happens.
- A trace of two signals sampled every 100 ms for 3 s holds 28 observations; it is not synchronous with the PLC cycle
  and says so.
- Absolute addresses of memory and process images (%MW, %ID, %QB) without a tag are not read: rung reports them as
  unsupported instead of guessing an offset.
## Sync under interruption

`tests/e2e/soak.e2e.test.ts` runs against a real TIA Portal V20: two people edit the same six blocks, one in the files and one in TIA Portal (a second Openness client), while `rung sync` runs and is killed at random moments, also in the middle of an import. After every step and at the end it checks:

- no conflict where nobody edited the same line;
- no crash and no stack trace from any sync;
- at the end, every file equals TIA Portal's export;
- both people's last values are there;
- nothing is left behind: no temporary or conflict files.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/soak-dark.png">
  <img src="media/soak-light.png" width="920" alt="Twenty minutes of sync against TIA Portal V20: 247 actions, 78 syncs killed mid-run, 42 merges, 0 conflicts, 0 check failures">
</picture>

| Run | Commit | Length | Steps | Syncs killed | Merges | Conflicts | Check failures |
|---|---|---|---|---|---|---|---|
| seed 11 | [fc47884](https://github.com/sa1ntsinner/rung/commit/fc47884) | 20 min | 255 | 78 | 42 | 0 | 0 |
| seed 7 | [c316eba](https://github.com/sa1ntsinner/rung/commit/c316eba) | 20 min | 276 | 75 | 48 | 0 | 0 |

The logs of both runs are in [media/soak.json](media/soak.json), one row per recorded action (seed 11: 247 rows for its 255 steps; the other 8 did nothing, such as creating a block that already exists; seed 7: all 276): seconds from the start, the action, after how many milliseconds the sync was killed (0: it ran to the end), and what the pass exported, imported, created, merged or found in conflict. Run it yourself with `RUNG_E2E=1 RUNG_SOAK_MINUTES=20 RUNG_SOAK_SEED=11 pnpm vitest run tests/e2e/soak.e2e.test.ts` on a PC with TIA Portal V20 and the fixture project ([CONTRIBUTING.md](../CONTRIBUTING.md)).

It shows that these sequences of edits, kills and merges lose nothing on that commit. It does not prove the same for every project, every TIA Portal update or every kind of object.

## The simulator against CODESYS

`tests/conformance/` holds twelve IEC programs that each compute their own results (integer widths and wrap, conversions and rounding, REAL precision, shifts and rotates, bit access, selection and math, control flow, arrays and structures, function block state, counters and triggers, strings, TIME). Their expected values were recorded from CODESYS V3.5 SP22 running them in its simulation; CI runs them on rung's simulator on every change (`packages/sim/test/conformance.test.ts`) and `RUNG_E2E_CODESYS=1 npx vitest run tests/e2e/conformance.e2e.test.ts` compares CODESYS with the recordings again.

Today 11 of the 12 programs match CODESYS exactly, 0 differ, and 1 is refused by rung on purpose: 64-bit integers beyond 2^53, which the simulator does not hold exactly and therefore stops at rather than rounding. What this shows is the shared IEC part of the simulator; Siemens-specific SCL is checked against an S7-1500 runtime in the next section.

## The simulator against an S7-1500 runtime

`tools/prove/` runs test cases in rung's simulator and, cycle by cycle, on PLCSIM Advanced V7.0 running the same blocks as TIA Portal V20 compiled and downloaded them to a CPU 1516-3 PN/DP (each cycle takes the test's cycle time in virtual time, so timers count alike), and compares every output after every step. Measured on 2026-10-06 with twelve blocks and their tests (`tools/prove/corpus/`):

- `examples/conveyor` FB_Conveyor: a start/stop latch, a 2 s contactor timeout, a 500 ms end-of-belt timer, an edge counter (5 cases, 66 values);
- FB_ProveOps: Int arithmetic with overflow, DIV and MOD of negative numbers, DInt products, SHL/SHR/ROL, word logic and bit access, REAL_TO_INT/ROUND/TRUNC including halves, INT/WORD conversions, MIN/MAX/LIMIT/ABS, operator precedence, FOR with a step, CASE ranges (4 cases, 290 values);
- FB_ProveTime: TON, TOF, TP with their ET, CTU and CTD, R_TRIG and F_TRIG, TIME arithmetic (2 cases, 240 values);
- FB_ProveData: arrays, a STRUCT, String LEN/CONCAT/LEFT/MID/FIND and comparison, LReal, DInt overflow, LInt, WHILE with EXIT, REPEAT, FOR with CONTINUE, nested IF/ELSIF (2 cases, 110 values);
- FB_ProveMath with FC_ProveAdd and FB_ProveInner: SQRT, SIN, EXP, LN, `**`, FRAC, NORM_X and SCALE_X, SEL and MUX, SWAP and ROR, INT_TO_STRING, REAL_TO_STRING and STRING_TO_INT, an FC with a return value and an in/out, a multi-instance that keeps its count across cycles (2 cases, 105 values);
- FB_ProveMore: RIGHT, DELETE, INSERT and REPLACE (also past the end of the text), CHAR codes, `%B`/`%W`/`%X` slices of a DWord, integer division and MOD by zero, LREAL_TO_STRING, an array of structures and an array of Bool (2 cases, 90 values);
- FB_ProveCalls with FC_ProveSum, FC_ProveEarly, FC_ProveSwap and FB_ProveChain: an array and a structure through an FC's in/out, RETURN early in an FC, a whole-array assignment, a chain of multi-instances with a TON and an R_TRIG inside, DATE and TIME_OF_DAY from a test, TOD + TIME, DATE - DATE (2 cases, 114 values);
- FB_ProveTypes with the PLC data type T_ProvePoint: USInt/UInt/UDInt wrap-around, Int times Real, REAL equality, Byte arithmetic, an array with negative bounds, a two-dimensional array, a data type's members, a constant (2 cases, 81 values);
- FB_ProveEdges: ABS and negation of -32768, DInt overflow, a REAL that overflows to infinity, ROUND and TRUNC of LReal halves, TONR, CTUD, String comparison (2 cases, 187 values);
- FB_ProveSys: MOVE_BLK and FILL_BLK into parts of arrays, MAX and MIN with three inputs, CONCAT with three, TIME addition and comparison, LTIME arithmetic and LTIME_TO_LINT (1 case, 46 values);
- two LAD blocks in SIMATIC SD (`packages/lsp/test/sd`): FB_Pump (branches, negated contacts, TON, compare, S/R coils; 1 case, 32 values) and Fx_LadEdges (P/N contacts and coils, P_TRIG, NOT, SR and RS; 1 case, 140 values).

All 26 cases and 1501 values are the same now. The runs found seventeen faults in rung, fixed with tests in `packages/sim/test/prove-findings.test.ts`: `NOT (x)` was read as a call; `SHL(...)` called a variable of the block named `shl`; test files did not take `16#00F3` for a Word; FRAC was missing; a number became text without the sign and exponent form an S7 CPU writes (`INT_TO_STRING(13824)` is `'+13824'`, `REAL_TO_STRING(2.25)` is `'+2.250000E+0'`, an LReal has 13 decimals); CHAR_TO_INT and INT_TO_CHAR did not convert; an integer divided by zero, and its MOD, stopped the case where the CPU gives 0; DELETE past the end of a text stopped where the CPU deletes to the end; observed members of structures in an array came out in capitals (`pts[0].X`); a DATE or TIME_OF_DAY set by a test stayed text, so `#tod + T#1H30M` joined strings (now days and milliseconds; and a CPU does not wrap a TIME_OF_DAY at midnight: TOD#23:15:00 + T#1H30M is 89 100 000 ms); a variable named like a word SCL reserves (`tod`, `time`, `date`, `int`, `Timer`, `Counter`, `string`, `dt`, `version`, `title`, `at`, `void`: TIA Portal refused all eleven) was no error in the editor; observed (and recorded) values named a two-dimensional array's elements `grid[0][1]` instead of `grid[0,1]`, and a PLC data type's members in capitals (`pt.X`); TONR was missing; an LTIME converted to a number was milliseconds where the CPU gives nanoseconds (`LTIME_TO_LINT(LT#3s)` = 3000000000). And one value no CPU defines: `REAL_TO_INT(32767.6)`, out of the range of Int, gave -205 on the CPU, where the simulator wrapped to -32768; the simulator now stops the case and says so instead of giving a number.

What this does not show: other CPUs and firmware, FBD and STL, ULInt and LWord beyond 2^53, interrupts and OB scheduling, system instructions, and steps with within/always/never (their length depends on the code).

## One production program

42 of the 43 blocks of one real machine program run in `rung test`, 8 of them with stubs (communication, technology objects). The program is confidential, so no names; it does not stand for general compatibility. What the simulator covers and refuses is in [testing.md](testing.md).

## Tests

| | |
|---|---|
| Bridge integration tests against TIA Portal V20 | 37 of 37 |
| End to end against TIA Portal, S7-PLCSIM and CODESYS | pass |
| TypeScript tests | 850+ |
| .NET tests | 243 |
| CI runners | Windows and Linux |

The tests against TIA Portal, PLCSIM and CODESYS run on a PC with those tools installed, not on the CI runners; CI runs the rest on every push.
